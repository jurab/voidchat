# voidchat

A minimalist voice-only chatroulette. Two strangers connect, talk, hang up, repeat. No video, no text, no accounts — just a black screen with a breathing orb that pulses when the other person speaks.

**[Live Demo](https://voidchat-erp.pages.dev)** ← try it

## Why

Sometimes you just want to talk to a stranger without the baggage of profiles, photos, or chat history. Voidchat strips away everything except the human voice.

## How it works

```
┌─────────────┐         ┌─────────────────────┐         ┌─────────────┐
│  Browser A  │◄───────►│  Cloudflare Worker  │◄───────►│  Browser B  │
│             │   WS    │  (signaling only)   │   WS    │             │
└──────┬──────┘         └─────────────────────┘         └──────┬──────┘
       │                                                        │
       │              WebRTC Peer Connection                    │
       │◄──────────────────────────────────────────────────────►│
       │                  (direct P2P audio)                    │
```

- **Signaling server** (Cloudflare Worker + Durable Object) handles matchmaking and WebRTC negotiation
- **Audio flows directly** between browsers via WebRTC — the server never touches it
- **Visualizer** uses Web Audio API to analyze incoming audio and animate the orb

## Tech stack

- **Frontend**: Vanilla JS, Web Audio API, WebRTC
- **Backend**: Cloudflare Workers with Durable Objects
- **Hosting**: Cloudflare Pages + Workers (free tier)
- **External**: Google STUN servers for NAT traversal

Total: ~600 lines of code.

## Features

- Voice-only P2P calls
- Real-time audio visualizer
- Live user count
- Rate limiting (10 connections/IP/min)
- Auto-reconnect on disconnect
- Mobile support

## Local development

```bash
# Quick start (both servers)
./dev.sh

# Or manually:
# Terminal 1: Start the signaling server
cd worker
npm install
npx wrangler dev --port 8787

# Terminal 2: Serve the frontend
cd frontend
npx serve -l 5555
```

Open `http://localhost:5555` and click "enter the void".

**Testing note:** To test with two clients locally, use two different browsers (e.g., Chrome + Safari) or one regular + one private window. Two tabs in the same browser session may interfere with each other due to shared WebSocket/WebRTC contexts.

## Deployment

```bash
# Login to Cloudflare
cd worker && npx wrangler login

# Deploy signaling server
npx wrangler deploy
# Note the URL: https://voice-roulette-signaling.YOUR_SUBDOMAIN.workers.dev

# Update frontend/app.js with your worker URL
# Then deploy frontend
cd ../frontend
npx wrangler pages project create voidchat
npx wrangler pages deploy . --project-name voidchat
```

## Debugging & Logging

The app has comprehensive logging for debugging connection issues.

### Fetching logs

All client and server logs are stored in the Durable Object's SQLite storage and can be fetched via HTTP:

```bash
# Get last 100 logs
curl https://voice-roulette-signaling.brazdil94.workers.dev/logs

# Get more logs
curl https://voice-roulette-signaling.brazdil94.workers.dev/logs?limit=500

# Filter by client ID (first 8 chars of UUID shown in logs)
curl https://voice-roulette-signaling.brazdil94.workers.dev/logs?client=abc12345

# Get logs since a timestamp
curl https://voice-roulette-signaling.brazdil94.workers.dev/logs?since=2025-12-28T14:00:00Z

# Clear all logs
curl https://voice-roulette-signaling.brazdil94.workers.dev/logs/clear
```

### What's logged

- **Server-side**: WebSocket connections/disconnections, matchmaking events, message forwarding
- **Client-side**: All WebRTC state changes (ICE gathering, connection state, signaling state), audio setup, errors

Client logs are sent to the server via WebSocket (`client_log` message type), rate-limited to 100 logs/client/minute.

### Cloudflare dashboard

Real-time logs are also available in Cloudflare dashboard:
Workers & Pages → voice-roulette-signaling → Logs

Persistent logging is enabled via `wrangler.toml` observability settings.

## Limitations

- ~15-20% of connections may fail on restrictive NATs (no TURN server)
- Single Durable Object instance (would need sharding at scale)
- No moderation

## Future ideas

- [ ] Group rooms (3-5 people) with push-to-talk
- [ ] TURN fallback for restrictive networks
- [ ] Geographic matching to reduce latency
- [ ] Voice activity detection to auto-skip silent connections

## License

MIT
