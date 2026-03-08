export interface Env {
  MATCHMAKER: DurableObjectNamespace;
  TURN_USERNAME: string;
  TURN_CREDENTIAL: string;
  HOST_TOKEN: string;
  HOST_NAME: string;
}

// Rate limit: max connections per IP per minute
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Voice Roulette Signaling Server", { status: 200 });
    }

    // TURN credentials endpoint
    if (url.pathname === "/turn-credentials") {
      // Minimal TURN config: UDP preferred, TLS/TCP fallback for strict firewalls
      const iceServers: object[] = [
        { urls: 'stun:stun.relay.metered.ca:80' },
      ];
      if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
        iceServers.push(
          { urls: 'turn:global.relay.metered.ca:443', username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL },
          { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL },
        );
      }
      return new Response(JSON.stringify({ iceServers }), {
        headers: { 
          'Content-Type': 'application/json',
          ...CORS_HEADERS
        }
      });
    }

    // WebSocket endpoint
    if (url.pathname === "/ws") {
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
  private env: Env;
  private connections: Map<string, WebSocket> = new Map();
  private userIps: Map<string, string> = new Map();
  private waiting: Set<string> = new Set();
  private pairs: Map<string, string> = new Map();
  private rateLimits: Map<string, RateLimitEntry> = new Map();
  private hostUserId: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private log(shortId: string | null, message: string) {
    const prefix = shortId ? `[${shortId}]` : '[SERVER]';
    console.log(`[${new Date().toISOString()}] ${prefix} ${message}`);
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
      this.log(null, `Rate limited: ${clientIp}`);
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
    const shortId = userId.slice(0, 8);

    ws.accept();

    this.connections.set(userId, ws);
    this.userIps.set(userId, clientIp);

    this.log(shortId, `Connected from ${clientIp}, total: ${this.connections.size}`);
    this.broadcastStats();

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);
        // Skip logging for client_log messages (we're removing that feature)
        if (data.type !== 'client_log') {
          this.log(shortId, `Received: ${data.type}`);
          this.handleMessage(userId, data, shortId);
        }
      } catch {
        this.log(shortId, `Invalid JSON received`);
        this.send(userId, { type: "error", message: "Invalid JSON" }, shortId);
      }
    });

    ws.addEventListener("close", (event) => {
      this.log(shortId, `Closed, code: ${event.code}`);
      this.handleDisconnect(userId, shortId);
    });

    ws.addEventListener("error", () => {
      this.log(shortId, `WebSocket error`);
      this.handleDisconnect(userId, shortId);
    });
  }

  private handleMessage(userId: string, data: { type: string; [key: string]: unknown }, shortId: string) {
    switch (data.type) {
      case "join":
        this.handleJoin(userId, shortId);
        break;

      case "offer":
      case "answer":
      case "ice":
        this.forwardToPartner(userId, data, shortId);
        break;

      case "next":
        this.handleNext(userId, shortId);
        break;

      case "auth":
        this.handleAuth(userId, data, shortId);
        break;

      case "leave":
        this.handleDisconnect(userId, shortId);
        break;

      default:
        this.log(shortId, `Unknown message type: ${data.type}`);
        this.send(userId, { type: "error", message: "Unknown message type" }, shortId);
    }
  }

  private handleJoin(userId: string, shortId: string) {
    // If already paired or waiting, ignore
    if (this.pairs.has(userId) || this.waiting.has(userId)) {
      return;
    }

    this.log(shortId, `Joining, waiting: ${this.waiting.size}`);

    // Try to find a waiting partner
    const waitingIterator = this.waiting.values().next();
    if (!waitingIterator.done) {
      const partnerId = waitingIterator.value;
      const partnerShortId = partnerId.slice(0, 8);
      this.waiting.delete(partnerId);

      // Create the pair (bidirectional)
      this.pairs.set(userId, partnerId);
      this.pairs.set(partnerId, userId);

      this.log(shortId, `Matched with [${partnerShortId}]`);

      // Notify both - the one who was waiting initiates
      this.send(partnerId, { type: "matched", initiator: true }, partnerShortId);
      this.send(userId, { type: "matched", initiator: false }, shortId);
      this.broadcastStats();
    } else {
      // No one waiting, add to pool
      this.waiting.add(userId);
      this.send(userId, { type: "waiting" }, shortId);
      this.broadcastStats();
    }
  }

  private forwardToPartner(userId: string, data: { type: string; [key: string]: unknown }, shortId: string) {
    const partnerId = this.pairs.get(userId);
    if (!partnerId) {
      this.send(userId, { type: "error", message: "Not paired" }, shortId);
      return;
    }

    this.send(partnerId, data, partnerId.slice(0, 8));
  }

  private handleNext(userId: string, shortId: string) {
    // Clean up current pair
    const partnerId = this.pairs.get(userId);
    if (partnerId) {
      this.pairs.delete(userId);
      this.pairs.delete(partnerId);
      this.send(partnerId, { type: "partner_left" }, partnerId.slice(0, 8));
    }

    // Remove from waiting if there
    this.waiting.delete(userId);

    // Rejoin the pool (handleJoin broadcasts stats on its own)
    this.handleJoin(userId, shortId);
  }

  private handleAuth(userId: string, data: { type: string; [key: string]: unknown }, shortId: string) {
    if (data.token === this.env.HOST_TOKEN) {
      this.hostUserId = userId;
      this.log(shortId, `Authenticated as host`);
      this.send(userId, { type: 'auth_ok' }, shortId);
      this.broadcastStats();
    } else {
      this.log(shortId, `Auth failed`);
      this.send(userId, { type: 'error', message: 'invalid_token' }, shortId);
    }
  }

  private handleDisconnect(userId: string, shortId: string) {
    // Notify partner if paired
    const partnerId = this.pairs.get(userId);
    if (partnerId) {
      this.pairs.delete(userId);
      this.pairs.delete(partnerId);
      this.send(partnerId, { type: "partner_left" }, partnerId.slice(0, 8));
    }

    // Remove from waiting pool
    this.waiting.delete(userId);

    // Clear host if this was the host
    if (this.hostUserId === userId) {
      this.hostUserId = null;
    }

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

    this.log(shortId, `Disconnected, total: ${this.connections.size}`);
    this.broadcastStats();
  }

  private getHostStatus(): string {
    if (!this.hostUserId || !this.connections.has(this.hostUserId)) {
      return 'away';
    }
    if (this.pairs.has(this.hostUserId)) {
      return 'busy';
    }
    if (this.waiting.has(this.hostUserId)) {
      return 'online';
    }
    // Connected but hasn't joined yet
    return 'away';
  }

  private broadcastStats() {
    const hostStatus = this.getHostStatus();
    const hostName = this.env.HOST_NAME || 'Host';
    // Count active users (in waiting + in pairs)
    const activeUserIds = new Set<string>();
    for (const id of this.waiting) activeUserIds.add(id);
    for (const id of this.pairs.keys()) activeUserIds.add(id);

    for (const [recipientId, ws] of this.connections) {
      // Online count excludes the recipient
      let online = 0;
      for (const id of activeUserIds) {
        if (id !== recipientId) online++;
      }
      try {
        ws.send(JSON.stringify({ type: 'stats', online, hostStatus, hostName }));
      } catch {
        // ignore
      }
    }
  }

  private send(userId: string, data: object, shortId: string) {
    const ws = this.connections.get(userId);
    if (ws) {
      try {
        ws.send(JSON.stringify(data));
      } catch {
        this.handleDisconnect(userId, shortId);
      }
    }
  }
}
