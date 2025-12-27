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
# Start the signaling server
cd worker
npm install
npx wrangler dev --port 8787

# In another terminal, serve the frontend
cd frontend
npx serve -l 5555
```

Open two tabs at `http://localhost:5555`, click "enter the void" in both.

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
