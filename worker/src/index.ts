export interface Env {
  MATCHMAKER: DurableObjectNamespace;
  TURN_USERNAME: string;
  TURN_CREDENTIAL: string;
}

// Rate limit: max connections per IP per minute
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Client log rate limiting
const CLIENT_LOG_MAX = 100;
const CLIENT_LOG_WINDOW_MS = 60_000;

// Log storage settings
const MAX_STORED_LOGS = 1000;

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
      const iceServers = [
        { urls: 'stun:stun.relay.metered.ca:80' },
        { 
          urls: 'turn:global.relay.metered.ca:80',
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL
        },
        { 
          urls: 'turn:global.relay.metered.ca:80?transport=tcp',
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL
        },
        { 
          urls: 'turn:global.relay.metered.ca:443',
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL
        },
        { 
          urls: 'turns:global.relay.metered.ca:443?transport=tcp',
          username: env.TURN_USERNAME,
          credential: env.TURN_CREDENTIAL
        },
      ];
      return new Response(JSON.stringify({ iceServers }), {
        headers: { 
          'Content-Type': 'application/json',
          ...CORS_HEADERS
        }
      });
    }

    // WebSocket endpoint and logs endpoint go to the Matchmaker
    if (url.pathname === "/ws" || url.pathname === "/logs" || url.pathname === "/logs/clear") {
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
  private clientLogCounts: Map<string, { count: number; resetAt: number }> = new Map();
  private dbInitialized: boolean = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async initDb() {
    if (this.dbInitialized) return;
    
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        client_id TEXT,
        message TEXT NOT NULL
      )
    `);
    this.dbInitialized = true;
  }

  private async storeLog(level: string, clientId: string | null, message: string) {
    await this.initDb();
    
    const timestamp = new Date().toISOString();
    this.state.storage.sql.exec(
      `INSERT INTO logs (timestamp, level, client_id, message) VALUES (?, ?, ?, ?)`,
      timestamp, level, clientId, message
    );

    // Also output to console for real-time viewing
    const prefix = clientId ? `[${clientId}]` : '[SERVER]';
    console.log(`[${timestamp}] ${prefix} ${level}: ${message}`);

    // Prune old logs if over limit
    this.state.storage.sql.exec(
      `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)`,
      MAX_STORED_LOGS
    );
  }

  private log(clientId: string | null, message: string) {
    this.storeLog('info', clientId, message);
  }

  private logError(clientId: string | null, message: string) {
    this.storeLog('error', clientId, message);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Logs endpoint - fetch stored logs
    if (url.pathname === "/logs") {
      await this.initDb();
      
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const since = url.searchParams.get('since'); // ISO timestamp
      const clientId = url.searchParams.get('client');
      
      let query = `SELECT * FROM logs`;
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (since) {
        conditions.push(`timestamp > ?`);
        params.push(since);
      }
      if (clientId) {
        conditions.push(`client_id = ?`);
        params.push(clientId);
      }

      if (conditions.length > 0) {
        query += ` WHERE ` + conditions.join(' AND ');
      }
      query += ` ORDER BY id DESC LIMIT ?`;
      params.push(limit);

      const results = this.state.storage.sql.exec(query, ...params).toArray();
      
      return new Response(JSON.stringify(results.reverse(), null, 2), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Clear logs endpoint
    if (url.pathname === "/logs/clear") {
      await this.initDb();
      this.state.storage.sql.exec(`DELETE FROM logs`);
      return new Response(JSON.stringify({ success: true, message: 'Logs cleared' }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

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

  private checkClientLogLimit(userId: string): boolean {
    const now = Date.now();
    let entry = this.clientLogCounts.get(userId);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + CLIENT_LOG_WINDOW_MS };
      this.clientLogCounts.set(userId, entry);
    }

    if (entry.count >= CLIENT_LOG_MAX) {
      return false;
    }

    entry.count++;
    return true;
  }

  private handleWebSocket(ws: WebSocket, clientIp: string) {
    const userId = crypto.randomUUID();
    const shortId = userId.slice(0, 8);

    ws.accept();

    this.connections.set(userId, ws);
    this.userIps.set(userId, clientIp);

    this.log(shortId, `Connected from ${clientIp}, total connections: ${this.connections.size}`);

    // Send current stats
    this.sendStats();

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type !== 'client_log') {
          this.log(shortId, `Received: ${data.type}`);
        }
        this.handleMessage(userId, data, shortId);
      } catch {
        this.log(shortId, `Invalid JSON received`);
        this.send(userId, { type: "error", message: "Invalid JSON" }, shortId);
      }
    });

    ws.addEventListener("close", (event) => {
      this.log(shortId, `WebSocket closed, code: ${event.code}, reason: ${event.reason}`);
      this.handleDisconnect(userId, shortId);
    });

    ws.addEventListener("error", (event) => {
      this.logError(shortId, `WebSocket error: ${event}`);
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

      case "leave":
        this.handleDisconnect(userId, shortId);
        break;

      case "client_log":
        // Client-side logs forwarded to server for debugging (rate limited)
        if (this.checkClientLogLimit(userId)) {
          const level = (data.level as string) || 'info';
          const message = `CLIENT: ${data.message}`;
          if (level === 'error') {
            this.logError(shortId, message);
          } else {
            this.log(shortId, message);
          }
        }
        break;

      default:
        this.log(shortId, `Unknown message type: ${data.type}`);
        this.send(userId, { type: "error", message: "Unknown message type" }, shortId);
    }
  }

  private handleJoin(userId: string, shortId: string) {
    // If already paired or waiting, ignore
    if (this.pairs.has(userId)) {
      this.log(shortId, `Join ignored - already paired`);
      return;
    }
    if (this.waiting.has(userId)) {
      this.log(shortId, `Join ignored - already waiting`);
      return;
    }

    this.log(shortId, `Joining, waiting pool size: ${this.waiting.size}`);

    // Try to find a waiting partner
    const waitingIterator = this.waiting.values().next();
    if (!waitingIterator.done) {
      const partnerId = waitingIterator.value;
      const partnerShortId = partnerId.slice(0, 8);
      this.waiting.delete(partnerId);

      // Create the pair (bidirectional)
      this.pairs.set(userId, partnerId);
      this.pairs.set(partnerId, userId);

      this.log(shortId, `Matched with [${partnerShortId}], pairs: ${this.pairs.size / 2}`);

      // Notify both - the one who was waiting initiates
      this.send(partnerId, { type: "matched", initiator: true }, partnerShortId);
      this.send(userId, { type: "matched", initiator: false }, shortId);
    } else {
      // No one waiting, add to pool
      this.waiting.add(userId);
      this.log(shortId, `Added to waiting pool, size: ${this.waiting.size}`);
      this.send(userId, { type: "waiting" }, shortId);
    }

    this.sendStats();
  }

  private forwardToPartner(userId: string, data: { type: string; [key: string]: unknown }, shortId: string) {
    const partnerId = this.pairs.get(userId);
    if (!partnerId) {
      this.log(shortId, `Cannot forward ${data.type} - not paired`);
      this.send(userId, { type: "error", message: "Not paired" }, shortId);
      return;
    }

    const partnerShortId = partnerId.slice(0, 8);
    this.log(shortId, `Forwarding ${data.type} to [${partnerShortId}]`);
    
    // Forward the message as-is
    this.send(partnerId, data, partnerShortId);
  }

  private handleNext(userId: string, shortId: string) {
    this.log(shortId, `Handling next`);
    
    // Clean up current pair
    const partnerId = this.pairs.get(userId);
    if (partnerId) {
      const partnerShortId = partnerId.slice(0, 8);
      this.pairs.delete(userId);
      this.pairs.delete(partnerId);
      this.log(shortId, `Unpaired from [${partnerShortId}]`);
      this.send(partnerId, { type: "partner_left" }, partnerShortId);
    }

    // Remove from waiting if there
    this.waiting.delete(userId);

    // Rejoin the pool
    this.handleJoin(userId, shortId);
  }

  private handleDisconnect(userId: string, shortId: string) {
    this.log(shortId, `Handling disconnect`);
    
    // Notify partner if paired
    const partnerId = this.pairs.get(userId);
    if (partnerId) {
      const partnerShortId = partnerId.slice(0, 8);
      this.pairs.delete(userId);
      this.pairs.delete(partnerId);
      this.log(shortId, `Was paired with [${partnerShortId}], notifying partner`);
      this.send(partnerId, { type: "partner_left" }, partnerShortId);
    }

    // Remove from waiting pool
    if (this.waiting.has(userId)) {
      this.waiting.delete(userId);
      this.log(shortId, `Removed from waiting pool`);
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

    this.log(shortId, `Disconnected, total connections: ${this.connections.size}`);
    this.sendStats();
  }

  private send(userId: string, data: object, shortId: string) {
    const ws = this.connections.get(userId);
    if (ws) {
      try {
        ws.send(JSON.stringify(data));
      } catch (err) {
        this.logError(shortId, `Send failed: ${err}`);
        // Connection might be dead, clean up
        this.handleDisconnect(userId, shortId);
      }
    } else {
      this.log(shortId, `Cannot send - no WebSocket found`);
    }
  }

  private sendStats() {
    const stats = { type: "stats", online: this.connections.size };
    for (const [userId] of this.connections) {
      const ws = this.connections.get(userId);
      if (ws) {
        try {
          ws.send(JSON.stringify(stats));
        } catch {
          // Ignore stats send failures
        }
      }
    }
  }
}
