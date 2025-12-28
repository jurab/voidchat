# voidchat

A minimalist voice-only chatroulette. Two strangers connect, talk, hang up, repeat. No video, no text, no accounts — just a black screen with a breathing orb that distorts like liquid when the other person speaks.

**[Live Demo](https://voidchat-erp.pages.dev)**

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
- **Visualizer** uses Web Audio API + SVG turbulence filter to create liquid distortion effects

## Tech stack

- **Frontend**: Vanilla JS, Web Audio API, WebRTC, SVG filters
- **Backend**: Cloudflare Workers with Durable Objects
- **Hosting**: Cloudflare Pages + Workers (free tier)
- **NAT traversal**: Google STUN servers + Metered.ca TURN relay fallback
- **Font**: Hoefler Text Italic

## Features

- Voice-only P2P calls with TURN fallback for restrictive NATs
- Liquid distortion visualizer — volume expands the orb, high frequencies create ripples
- Two-step entry: mic permission first, then "enter the void"
- Exploding text animation on "enter the void" — letters shake, glimmer, then crumble downward
- Click the orb to skip (tremor animation on rejection)
- Pulsing "waiting" text while searching
- "Hello wiggle" when connected
- Smooth fade transitions between states
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

**Testing note:** Use two different browsers or one regular + one private window. Two tabs in the same browser session may interfere with each other.

## Deployment

```bash
# Login to Cloudflare
cd worker && npx wrangler login

# Set TURN credentials (from Metered.ca dashboard)
npx wrangler secret put TURN_USERNAME
npx wrangler secret put TURN_CREDENTIAL

# Deploy signaling server
npx wrangler deploy

# Deploy frontend
cd ../frontend
npx wrangler pages deploy . --project-name voidchat
```

## Debugging & Logging

All client and server logs are stored in the Durable Object's SQLite storage:

```bash
# Get last 100 logs
curl https://voice-roulette-signaling.brazdil94.workers.dev/logs

# Filter by client ID
curl https://voice-roulette-signaling.brazdil94.workers.dev/logs?client=abc12345

# Clear all logs
curl https://voice-roulette-signaling.brazdil94.workers.dev/logs/clear
```

## Limitations

- Single Durable Object instance (would need sharding at scale)
- No moderation

## License

MIT
