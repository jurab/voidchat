export interface Env {
  MATCHMAKER: DurableObjectNamespace;
}

// Rate limit: max connections per IP per minute
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Voice Roulette Signaling Server", { status: 200 });
    }

    // WebSocket endpoint
    if (url.pathname === "/ws") {
      // All connections go to the singleton Matchmaker
      const id = env.MATCHMAKER.idFromName("singleton");
      const stub = env.MATCHMAKER.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

interface RateLimitEntry {
  timestamps: number[];
}

export class Matchmaker {
  private state: DurableObjectState;
  private connections: Map<string, WebSocket> = new Map();
  private userIps: Map<string, string> = new Map();
  private waiting: Set<string> = new Set();
  private pairs: Map<string, string> = new Map();
  private rateLimits: Map<string, RateLimitEntry> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/ws") {
      return new Response("Not found", { status: 404 });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    // Get client IP for rate limiting
    const clientIp = request.headers.get("CF-Connecting-IP") || 
                     request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || 
                     "unknown";

    // Check rate limit
    if (!this.checkRateLimit(clientIp)) {
      return new Response("Rate limited", { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.handleWebSocket(server, clientIp);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    let entry = this.rateLimits.get(ip);

    if (!entry) {
      entry = { timestamps: [] };
      this.rateLimits.set(ip, entry);
    }

    // Remove old timestamps
    entry.timestamps = entry.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

    if (entry.timestamps.length >= RATE_LIMIT_MAX) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  private handleWebSocket(ws: WebSocket, clientIp: string) {
    const userId = crypto.randomUUID();

    ws.accept();

    this.connections.set(userId, ws);
    this.userIps.set(userId, clientIp);

    // Send current stats
    this.sendStats();

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);
        this.handleMessage(userId, data);
      } catch {
        this.send(userId, { type: "error", message: "Invalid JSON" });
      }
    });

    ws.addEventListener("close", () => {
      this.handleDisconnect(userId);
    });

    ws.addEventListener("error", () => {
      this.handleDisconnect(userId);
    });
  }

  private handleMessage(userId: string, data: { type: string; [key: string]: unknown }) {
    switch (data.type) {
      case "join":
        this.handleJoin(userId);
        break;

      case "offer":
      case "answer":
      case "ice":
        this.forwardToPartner(userId, data);
        break;

      case "next":
        this.handleNext(userId);
        break;

      case "leave":
        this.handleDisconnect(userId);
        break;

      default:
        this.send(userId, { type: "error", message: "Unknown message type" });
    }
  }

  private handleJoin(userId: string) {
    // If already paired or waiting, ignore
    if (this.pairs.has(userId) || this.waiting.has(userId)) {
      return;
    }

    // Try to find a waiting partner
    const waitingIterator = this.waiting.values().next();
    if (!waitingIterator.done) {
      const partnerId = waitingIterator.value;
      this.waiting.delete(partnerId);

      // Create the pair (bidirectional)
      this.pairs.set(userId, partnerId);
      this.pairs.set(partnerId, userId);

      // Notify both - the one who was waiting initiates
      this.send(partnerId, { type: "matched", initiator: true });
      this.send(userId, { type: "matched", initiator: false });
    } else {
      // No one waiting, add to pool
      this.waiting.add(userId);
      this.send(userId, { type: "waiting" });
    }

    this.sendStats();
  }

  private forwardToPartner(userId: string, data: { type: string; [key: string]: unknown }) {
    const partnerId = this.pairs.get(userId);
    if (!partnerId) {
      this.send(userId, { type: "error", message: "Not paired" });
      return;
    }

    // Forward the message as-is
    this.send(partnerId, data);
  }

  private handleNext(userId: string) {
    // Clean up current pair
    const partnerId = this.pairs.get(userId);
    if (partnerId) {
      this.pairs.delete(userId);
      this.pairs.delete(partnerId);
      this.send(partnerId, { type: "partner_left" });
    }

    // Remove from waiting if there
    this.waiting.delete(userId);

    // Rejoin the pool
    this.handleJoin(userId);
  }

  private handleDisconnect(userId: string) {
    // Notify partner if paired
    const partnerId = this.pairs.get(userId);
    if (partnerId) {
      this.pairs.delete(userId);
      this.pairs.delete(partnerId);
      this.send(partnerId, { type: "partner_left" });
    }

    // Remove from waiting pool
    this.waiting.delete(userId);

    // Clean up connection
    const ws = this.connections.get(userId);
    if (ws) {
      try {
        ws.close();
      } catch {
        // Already closed
      }
    }
    this.connections.delete(userId);
    this.userIps.delete(userId);

    this.sendStats();
  }

  private send(userId: string, data: object) {
    const ws = this.connections.get(userId);
    if (ws) {
      try {
        ws.send(JSON.stringify(data));
      } catch {
        // Connection might be dead, clean up
        this.handleDisconnect(userId);
      }
    }
  }

  private sendStats() {
    const stats = { type: "stats", online: this.connections.size };
    for (const [userId] of this.connections) {
      this.send(userId, stats);
    }
  }
}
