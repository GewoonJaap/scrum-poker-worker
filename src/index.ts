// TypeScript interfaces for our data structures
interface CardData {
  value: string;
  color: string;
}

interface User {
  id: string;
  name: string;
  vote: CardData | null;
}

interface Session {
  socket: WebSocket;
  userId: string;
}

interface Env {
  POKER_ROOM: DurableObjectNamespace;
}

// A Durable Object's behavior is defined in an exported Javascript class
export class PokerRoom {
  private sessions: Session[];
  private users: Record<string, User>;
  private revealed: boolean;
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.sessions = [];
    this.users = {};
    this.revealed = false;
  }

  // The system will call fetch() whenever a client sends a request to this Object.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId");

    if (!userId) {
      console.error("Fetch request missing userId");
      return new Response("userId is required", { status: 400 });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    await this.handleSession(server, userId);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleSession(socket: WebSocket, userId: string): Promise<void> {
    socket.accept();
    this.sessions.push({ socket, userId });
    console.log(`[${this.state.id.toString()}] Accepted WebSocket connection for user: ${userId}`);
    
    // Initialize user if not present
    if (!this.users[userId]) {
        this.users[userId] = { id: userId, name: `User ${userId.substring(0, 4)}`, vote: null };
        console.log(`[${this.state.id.toString()}] Initialized new user: ${JSON.stringify(this.users[userId])}`);
    }

    // Broadcast the current state to all users
    this.broadcastState();

    socket.addEventListener("message", async (msg) => {
        try {
            const data = JSON.parse(msg.data);
            console.log(`[${this.state.id.toString()}] Received message from ${userId}:`, JSON.stringify(data));

            const user = this.users[userId];
            if (!user) {
                console.warn(`[${this.state.id.toString()}] Received message from disconnected user ${userId}. Ignoring.`);
                return;
            }

            switch (data.type) {
                case 'vote':
                    user.vote = data.card;
                    this.broadcastState();
                    break;
                case 'reveal':
                    this.revealed = true;
                    this.broadcastState();
                    break;
                case 'reset':
                    this.revealed = false;
                    for (const u of Object.values(this.users)) {
                        u.vote = null;
                    }
                    this.broadcastState();
                    break;
                case 'setName':
                    if (data.name) {
                        user.name = data.name;
                    }
                    this.broadcastState();
                    break;
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            console.error(`[${this.state.id.toString()}] Error parsing message or handling event for user ${userId}:`, errorMessage, err);
            socket.send(JSON.stringify({ error: errorMessage }));
        }
    });

    socket.addEventListener("close", (event) => {
        console.log(`[${this.state.id.toString()}] Socket closed for user ${userId}. Code: ${event.code}, Reason: ${event.reason}`);
        this.sessions = this.sessions.filter(s => s.socket !== socket);
        delete this.users[userId];
        this.broadcastState();
    });

    socket.addEventListener("error", (event) => {
        console.error(`[${this.state.id.toString()}] Socket error for user ${userId}:`, event);
    });
  }

  broadcastState() {
      const state = {
          type: 'state',
          users: Object.values(this.users),
          revealed: this.revealed,
      };
      const message = JSON.stringify(state);
      console.log(`[${this.state.id.toString()}] Broadcasting state to ${this.sessions.length} clients`);
      
      const stillConnectedSessions: Session[] = [];
      this.sessions.forEach(session => {
          try {
              session.socket.send(message);
              stillConnectedSessions.push(session);
          } catch (e) {
              console.error(`[${this.state.id.toString()}] Failed to send to user ${session.userId}, removing session.`, e);
              // This session is dead. Clean up the user associated with it.
              delete this.users[session.userId];
          }
      });
      this.sessions = stillConnectedSessions;
  }
}


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let url = new URL(request.url);
    let roomId = url.pathname.slice(1);

    // Enforce a roomId
    if (!roomId) {
      roomId = crypto.randomUUID();
      return Response.redirect(`${url.origin}/${roomId}${url.search}`, 302);
    }

    let id = env.POKER_ROOM.idFromName(roomId);
    let stub = env.POKER_ROOM.get(id);

    // Pass the request to the Durable Object.
    return await stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;