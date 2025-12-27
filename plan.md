# Voice Roulette - Implementation Battleplan

## Project Overview

A minimalist voice-only chatroulette clone. Two strangers connect, talk, hang up, repeat. Black screen with a breathing visualizer that responds to the other person's voice. No accounts, no history, no bullshit.

### Core Philosophy
- **Zero cost** - abuse free tiers everywhere
- **Minimal UI** - black screen, one pulsing circle, maybe a "next" button
- **Browser only** - no app stores, no installs
- **Peer to peer voice** - server only handles matchmaking, not audio data

---

## Architecture

```
┌─────────────┐         ┌─────────────────────┐         ┌─────────────┐
│  Browser A  │◄───────►│  Cloudflare Worker  │◄───────►│  Browser B  │
│             │   WS    │  (signaling only)   │   WS    │             │
└──────┬──────┘         └─────────────────────┘         └──────┬──────┘
       │                                                        │
       │              WebRTC Peer Connection                    │
       │◄──────────────────────────────────────────────────────►│
       │                  (direct audio)                        │
```

### Components

1. **Cloudflare Worker** (signaling server)
   - Handles websocket connections
   - Maintains a waiting pool
   - Pairs users randomly
   - Forwards SDP offers/answers and ICE candidates between paired users
   - That's literally it

2. **Static Frontend** (Cloudflare Pages)
   - Single HTML file, inline CSS and JS probably fine
   - WebRTC logic
   - Audio visualizer using Web Audio API
   - Websocket client for signaling

3. **External Dependencies**
   - Google's public STUN servers (stun:stun.l.google.com:19302)
   - adapter.js for WebRTC browser compatibility shim

---

## Tech Stack

### Backend (Cloudflare Worker)
- **Runtime**: Cloudflare Workers with Durable Objects (for websocket state)
- **Language**: TypeScript
- **Why Durable Objects**: Regular workers are stateless, but we need to maintain the waiting pool and paired connections. Durable Objects give us a single point of coordination with websocket support.

### Frontend
- **Vanilla JS** - no framework needed for something this simple
- **Web Audio API** - for the voice visualizer
- **WebRTC API** - for peer connections
- **adapter.js** - browser compatibility shim (load from CDN)

### Hosting
- **Cloudflare Pages** - static frontend hosting, free tier
- **Cloudflare Workers** - signaling backend, free tier (100k requests/day)

---

## Detailed Implementation Plan

### Phase 1: Project Setup

1. **Create project structure**
   ```
   voice-roulette/
   ├── worker/
   │   ├── src/
   │   │   └── index.ts          # Main worker + durable object
   │   ├── wrangler.toml         # Cloudflare config
   │   ├── package.json
   │   └── tsconfig.json
   ├── frontend/
   │   ├── index.html            # Single page app
   │   ├── style.css             # Minimal styles (could inline)
   │   └── app.js                # All client logic
   └── README.md
   ```

2. **Initialize Cloudflare Worker project**
   ```bash
   cd worker
   npm init -y
   npm install -D wrangler typescript @cloudflare/workers-types
   npx wrangler init
   ```

3. **Configure wrangler.toml**
   ```toml
   name = "voice-roulette-signaling"
   main = "src/index.ts"
   compatibility_date = "2024-01-01"

   [[durable_objects.bindings]]
   name = "MATCHMAKER"
   class_name = "Matchmaker"

   [[migrations]]
   tag = "v1"
   new_classes = ["Matchmaker"]
   ```

---

### Phase 2: Signaling Server (Cloudflare Worker)

#### The Durable Object: Matchmaker

This is the brain. It maintains:
- A pool of waiting users (websocket connections)
- Currently paired users
- Handles all message routing

#### Message Protocol

All messages are JSON with a `type` field:

**Client → Server:**
```typescript
{ type: "join" }                                    // Enter the pool
{ type: "leave" }                                   // Leave voluntarily
{ type: "offer", sdp: RTCSessionDescriptionInit }  // WebRTC offer
{ type: "answer", sdp: RTCSessionDescriptionInit } // WebRTC answer
{ type: "ice", candidate: RTCIceCandidateInit }    // ICE candidate
{ type: "next" }                                    // Skip current partner, find new one
```

**Server → Client:**
```typescript
{ type: "waiting" }                                 // You're in the pool, waiting
{ type: "matched", initiator: boolean }            // Found a partner, initiator creates offer
{ type: "offer", sdp: RTCSessionDescriptionInit }  // Forwarded offer from partner
{ type: "answer", sdp: RTCSessionDescriptionInit } // Forwarded answer from partner
{ type: "ice", candidate: RTCIceCandidateInit }    // Forwarded ICE candidate from partner
{ type: "partner_left" }                           // Your partner disconnected
{ type: "error", message: string }                 // Something went wrong
```

#### Worker Implementation Skeleton

```typescript
// src/index.ts

export interface Env {
  MATCHMAKER: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // All websocket connections go to the single Matchmaker instance
    const id = env.MATCHMAKER.idFromName("singleton");
    const stub = env.MATCHMAKER.get(id);
    return stub.fetch(request);
  },
};

export class Matchmaker {
  private state: DurableObjectState;
  private waiting: Map<string, WebSocket> = new Map();
  private pairs: Map<string, string> = new Map(); // odwójne mapowanie A→B i B→A

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.handleWebSocket(server);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    return new Response("Voice Roulette Signaling Server", { status: 200 });
  }

  private handleWebSocket(ws: WebSocket) {
    const userId = crypto.randomUUID();
    
    ws.accept();

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);
        this.handleMessage(userId, ws, data);
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      }
    });

    ws.addEventListener("close", () => {
      this.handleDisconnect(userId);
    });

    ws.addEventListener("error", () => {
      this.handleDisconnect(userId);
    });
  }

  private handleMessage(userId: string, ws: WebSocket, data: any) {
    switch (data.type) {
      case "join":
        this.handleJoin(userId, ws);
        break;
      case "offer":
      case "answer":
      case "ice":
        this.forwardToPartner(userId, data);
        break;
      case "next":
        this.handleNext(userId, ws);
        break;
      case "leave":
        this.handleDisconnect(userId);
        break;
    }
  }

  private handleJoin(userId: string, ws: WebSocket) {
    // If someone is waiting, pair them
    if (this.waiting.size > 0) {
      const [partnerId, partnerWs] = this.waiting.entries().next().value;
      this.waiting.delete(partnerId);

      // Create the pair
      this.pairs.set(userId, partnerId);
      this.pairs.set(partnerId, userId);

      // Store websockets for message forwarding (need separate map)
      // Actually we need to track websockets differently...
      // Let me restructure this

      // Tell both they're matched
      // The "initiator" (first one) creates the WebRTC offer
      partnerWs.send(JSON.stringify({ type: "matched", initiator: true }));
      ws.send(JSON.stringify({ type: "matched", initiator: false }));
    } else {
      // No one waiting, add to pool
      this.waiting.set(userId, ws);
      ws.send(JSON.stringify({ type: "waiting" }));
    }
  }

  private forwardToPartner(userId: string, data: any) {
    const partnerId = this.pairs.get(userId);
    if (!partnerId) return;

    // Need to get partner's websocket...
    // This is where the implementation needs refinement
    // We need a separate map: userId → WebSocket
  }

  private handleNext(userId: string, ws: WebSocket) {
    // Disconnect from current partner
    this.handleDisconnect(userId);
    // Rejoin the pool
    this.handleJoin(userId, ws);
  }

  private handleDisconnect(userId: string) {
    // Remove from waiting pool
    this.waiting.delete(userId);

    // If paired, notify partner and clean up
    const partnerId = this.pairs.get(userId);
    if (partnerId) {
      this.pairs.delete(userId);
      this.pairs.delete(partnerId);
      
      // Notify partner they're alone now
      // Need websocket reference...
    }
  }
}
```

**NOTE**: The skeleton above has a flaw - we need to track websockets separately from the waiting pool so we can forward messages to paired users. Refactored version needed:

```typescript
private connections: Map<string, WebSocket> = new Map();  // all active connections
private waiting: Set<string> = new Set();                  // just IDs of those waiting
private pairs: Map<string, string> = new Map();            // paired user mappings
```

---

### Phase 3: Frontend Implementation

#### HTML Structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Roulette</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      background: #000;
      color: #fff;
      font-family: system-ui, -apple-system, sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    #visualizer {
      width: 200px;
      height: 200px;
      border-radius: 50%;
      background: radial-gradient(circle, #333 0%, #111 100%);
      transition: transform 0.1s ease-out, box-shadow 0.1s ease-out;
    }

    #visualizer.active {
      box-shadow: 0 0 60px rgba(255, 255, 255, 0.3);
    }

    #status {
      margin-top: 40px;
      font-size: 14px;
      color: #666;
      text-transform: lowercase;
    }

    #next-btn {
      margin-top: 30px;
      padding: 12px 32px;
      background: transparent;
      border: 1px solid #333;
      color: #666;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s;
      text-transform: lowercase;
    }

    #next-btn:hover {
      border-color: #666;
      color: #999;
    }

    #next-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    #start-btn {
      padding: 16px 48px;
      background: #fff;
      border: none;
      color: #000;
      font-size: 16px;
      cursor: pointer;
      text-transform: lowercase;
    }

    #start-btn:hover {
      background: #ccc;
    }

    .hidden {
      display: none !important;
    }
  </style>
</head>
<body>
  <!-- Initial state: need user gesture for mic permission -->
  <button id="start-btn">enter</button>

  <!-- Main UI: shown after mic permission granted -->
  <div id="main-ui" class="hidden">
    <div id="visualizer"></div>
    <div id="status">connecting...</div>
    <button id="next-btn" disabled>next</button>
  </div>

  <!-- adapter.js for WebRTC compatibility -->
  <script src="https://webrtc.github.io/adapter/adapter-latest.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

#### JavaScript Implementation

```javascript
// app.js

const SIGNALING_URL = 'wss://voice-roulette-signaling.YOUR_SUBDOMAIN.workers.dev/ws';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

// DOM elements
const startBtn = document.getElementById('start-btn');
const mainUI = document.getElementById('main-ui');
const visualizer = document.getElementById('visualizer');
const status = document.getElementById('status');
const nextBtn = document.getElementById('next-btn');

// State
let localStream = null;
let peerConnection = null;
let websocket = null;
let audioContext = null;
let analyser = null;
let isInitiator = false;

// ============================================
// INITIALIZATION
// ============================================

startBtn.addEventListener('click', async () => {
  try {
    // Request microphone access (requires user gesture)
    localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }, 
      video: false 
    });

    // Hide start button, show main UI
    startBtn.classList.add('hidden');
    mainUI.classList.remove('hidden');

    // Connect to signaling server
    connectSignaling();

  } catch (err) {
    console.error('Failed to get microphone:', err);
    alert('Microphone access is required. Please allow and try again.');
  }
});

nextBtn.addEventListener('click', () => {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    cleanupPeerConnection();
    websocket.send(JSON.stringify({ type: 'next' }));
    setStatus('finding someone new...');
    nextBtn.disabled = true;
  }
});

// ============================================
// SIGNALING
// ============================================

function connectSignaling() {
  websocket = new WebSocket(SIGNALING_URL);

  websocket.onopen = () => {
    console.log('Signaling connected');
    websocket.send(JSON.stringify({ type: 'join' }));
    setStatus('waiting for someone...');
  };

  websocket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleSignalingMessage(data);
  };

  websocket.onclose = () => {
    console.log('Signaling disconnected');
    setStatus('disconnected - refreshing...');
    // Auto-reconnect after a delay
    setTimeout(() => {
      if (localStream) {
        connectSignaling();
      }
    }, 2000);
  };

  websocket.onerror = (err) => {
    console.error('Signaling error:', err);
  };
}

function handleSignalingMessage(data) {
  switch (data.type) {
    case 'waiting':
      setStatus('waiting for someone...');
      nextBtn.disabled = true;
      break;

    case 'matched':
      setStatus('connecting...');
      isInitiator = data.initiator;
      createPeerConnection();
      if (isInitiator) {
        createOffer();
      }
      break;

    case 'offer':
      handleOffer(data.sdp);
      break;

    case 'answer':
      handleAnswer(data.sdp);
      break;

    case 'ice':
      handleIceCandidate(data.candidate);
      break;

    case 'partner_left':
      cleanupPeerConnection();
      setStatus('they left - finding someone new...');
      websocket.send(JSON.stringify({ type: 'join' }));
      nextBtn.disabled = true;
      break;

    case 'error':
      console.error('Server error:', data.message);
      setStatus('error: ' + data.message);
      break;
  }
}

// ============================================
// WEBRTC
// ============================================

function createPeerConnection() {
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Add local audio track
  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  // Handle incoming audio
  peerConnection.ontrack = (event) => {
    console.log('Received remote track');
    const remoteStream = event.streams[0];
    setupRemoteAudio(remoteStream);
    setStatus('connected');
    nextBtn.disabled = false;
  };

  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      websocket.send(JSON.stringify({
        type: 'ice',
        candidate: event.candidate.toJSON()
      }));
    }
  };

  // Connection state monitoring
  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'failed') {
      setStatus('connection failed - try next');
      nextBtn.disabled = false;
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE state:', peerConnection.iceConnectionState);
  };
}

async function createOffer() {
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    websocket.send(JSON.stringify({
      type: 'offer',
      sdp: peerConnection.localDescription.toJSON()
    }));
  } catch (err) {
    console.error('Failed to create offer:', err);
  }
}

async function handleOffer(sdp) {
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    websocket.send(JSON.stringify({
      type: 'answer',
      sdp: peerConnection.localDescription.toJSON()
    }));
  } catch (err) {
    console.error('Failed to handle offer:', err);
  }
}

async function handleAnswer(sdp) {
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (err) {
    console.error('Failed to handle answer:', err);
  }
}

async function handleIceCandidate(candidate) {
  try {
    if (peerConnection && candidate) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('Failed to add ICE candidate:', err);
  }
}

function cleanupPeerConnection() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
    analyser = null;
  }
  visualizer.style.transform = 'scale(1)';
  visualizer.classList.remove('active');
}

// ============================================
// AUDIO VISUALIZATION
// ============================================

function setupRemoteAudio(stream) {
  // Create audio context
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  
  // Create analyser node
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  
  // Connect remote stream to analyser
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);
  
  // Also play the audio
  const audioElement = new Audio();
  audioElement.srcObject = stream;
  audioElement.play();

  // Start visualization loop
  visualize();
}

function visualize() {
  if (!analyser) return;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  
  function draw() {
    if (!analyser) return;
    
    requestAnimationFrame(draw);
    
    analyser.getByteFrequencyData(dataArray);
    
    // Calculate average volume
    const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
    
    // Map to scale (1.0 to 1.5)
    const scale = 1 + (average / 255) * 0.5;
    
    // Apply to visualizer
    visualizer.style.transform = `scale(${scale})`;
    
    // Add glow when speaking
    if (average > 30) {
      visualizer.classList.add('active');
    } else {
      visualizer.classList.remove('active');
    }
  }
  
  draw();
}

// ============================================
// UTILITY
// ============================================

function setStatus(text) {
  status.textContent = text;
}

// Handle page unload
window.addEventListener('beforeunload', () => {
  if (websocket) {
    websocket.send(JSON.stringify({ type: 'leave' }));
    websocket.close();
  }
  cleanupPeerConnection();
});
```

---

### Phase 4: Deployment

#### Deploy Worker

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

This will give you a URL like `https://voice-roulette-signaling.YOUR_SUBDOMAIN.workers.dev`

Update the `SIGNALING_URL` in `app.js` with this URL (use `wss://` for websocket).

#### Deploy Frontend

```bash
cd frontend
npx wrangler pages project create voice-roulette
npx wrangler pages deploy . --project-name voice-roulette
```

Or just connect the repo to Cloudflare Pages via the dashboard, it'll auto-deploy.

---

### Phase 5: Testing Checklist

#### Local Testing
- [ ] Test with two browser tabs locally
- [ ] Test mic permission flow
- [ ] Test the visualization responds to voice
- [ ] Test "next" button pairs you with someone new
- [ ] Test closing tab notifies partner

#### Cross-Browser Testing
- [ ] Chrome desktop
- [ ] Firefox desktop
- [ ] Safari desktop
- [ ] Chrome Android
- [ ] Safari iOS (this will be the annoying one)

#### Network Testing
- [ ] Both users on same WiFi (easy mode)
- [ ] Users on different networks
- [ ] One user on mobile data (NAT traversal stress test)
- [ ] Both users on mobile data (might fail without TURN, expected)

---

## Known Limitations & Future Improvements

### Current Limitations (Intentional for MVP)
1. **No TURN server** - ~15-20% of connections will fail on restrictive networks
2. **Single Durable Object** - all users go through one instance, will need sharding at scale
3. **No moderation** - anyone can say anything
4. **No geographic matching** - you might get someone with 300ms latency

### Future Ideas (Post-MVP)
1. **Add TURN fallback** - metered.ca free tier or self-hosted coturn
2. **Geographic sharding** - run multiple Durable Objects per region
3. **Report/block** - basic moderation
4. **Voice activity detection** - auto-skip silent connections
5. **Topic rooms** - optional "I want to talk about X" matching
6. **Time limit** - force rotation after N minutes for chatroulette energy

---

## File Checklist

When complete, you should have:

```
voice-roulette/
├── worker/
│   ├── src/
│   │   └── index.ts              # ~150 lines
│   ├── wrangler.toml             # ~15 lines
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── index.html                # ~80 lines
│   └── app.js                    # ~250 lines
└── README.md
```

Total: ~500 lines of code for the whole thing.

---

## Quick Start Commands

```bash
# Clone/create the repo
mkdir voice-roulette && cd voice-roulette

# Set up worker
mkdir -p worker/src
cd worker
npm init -y
npm install -D wrangler typescript @cloudflare/workers-types
# ... create files ...
npx wrangler deploy

# Set up frontend
cd ..
mkdir frontend
cd frontend
# ... create files ...
npx wrangler pages deploy . --project-name voice-roulette
```

---

## Questions To Answer Before Starting

1. **Domain name?** - Custom domain or fine with `*.pages.dev`?
2. **Analytics?** - Want to track usage? Cloudflare Analytics is free and privacy-respecting
3. **Error tracking?** - Sentry free tier? Or just console.log and hope?
4. **Rate limiting?** - Prevent abuse? Cloudflare has built-in options

---

glhf, dej vědět jak to půjde 🤙
