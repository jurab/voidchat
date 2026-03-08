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
- **Font**: ADolphin Italic

## Features

- Voice-only P2P calls with TURN fallback for restrictive NATs
- **Host presence** — visitors see whether the host (Jura) is away/online/busy
- Sphere visible from page load — static orb with text inside
- Liquid distortion visualizer — volume expands the orb, high frequencies create ripples
- Single-click "press to talk" entry (displayed inside the sphere)
- Two breathing modes: subtle pulsing while waiting, full breathing when connected
- CRT turn-off effect with tremor when skipping
- "Hello wiggle" when connected
- Hover glow effect on "enter the void" state
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

Open `http://localhost:5555` and click "press to talk".

**Host auth (local):** Uncomment the `<input>` in `frontend/index.html`, type the token from `worker/.dev.vars` (`test` by default), hit Enter. Then click "press to talk" to go online.

**Testing note:** Use two different browsers or one regular + one private window. Two tabs in the same browser session may interfere with each other.

## Deployment

```bash
# Login to Cloudflare
cd worker && npx wrangler login

# Set secrets
npx wrangler secret put TURN_USERNAME    # from Metered.ca dashboard
npx wrangler secret put TURN_CREDENTIAL  # from Metered.ca dashboard
npx wrangler secret put HOST_TOKEN       # secret passphrase for host auth

# Deploy signaling server
npx wrangler deploy

# Deploy frontend
cd ../frontend
npx wrangler pages deploy . --project-name voidchat
```

## Limitations

- Single Durable Object instance (would need sharding at scale)
- No moderation

## License

MIT
