# Deployment & Operations

Everything ships as one Node server (`apps/server`) that serves the built web
client, plus optional Redis, Caddy TLS, and self-hosted Umami — all wired as
profiles in `docker-compose.yaml`.

## 1. Prerelease checklist (do this first)

See `docs/LAUNCH_CHECKLIST.md` for the business/legal items — **trademark
clearance for the published name and game art is the owner's action** and must
be verified before a public launch.

## 2. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `REDIS_URL` | recommended | Room + shop profile persistence across restarts (falls back to in-memory single-node). |
| `SESSION_SECRET` | yes | Socket/session signing. |
| `DOMAIN`, `ACME_EMAIL` | for TLS | Caddy profile: automatic Let's Encrypt certs. |
| `STRIPE_SECRET_KEY` | for paid cosmetics | Activates Stripe Checkout. |
| `STRIPE_WEBHOOK_SECRET` | for paid cosmetics | Verifies `POST /api/shop/webhook` signatures. |
| `APP_ORIGIN` | for paid cosmetics | Success/cancel redirect origin (e.g. `https://play.example.com`). |
| `SENTRY_DSN` / `VITE_SENTRY_DSN` | optional | Error tracking (server / web build). No-ops when unset. |
| `VITE_UMAMI_SRC`, `VITE_UMAMI_WEBSITE_ID` | optional | Self-hosted analytics at build time. No-ops when unset. |
| `VITE_ICE_SERVERS` | optional | JSON array of RTCIceServer dicts. STUN-only default works for most home networks; add TURN for restrictive corporate NATs. |

## 3. Deploy (Docker Compose)

```bash
export DOMAIN=play.example.com
export ACME_EMAIL=you@example.com
export SESSION_SECRET=$(openssl rand -hex 32)
export APP_ORIGIN=https://$DOMAIN
docker compose --profile proxy up -d --build
```

- The `proxy` profile starts Caddy with automatic HTTPS (wire ports 80/443).
- Redis starts automatically as a dependency of the app service.
- Health check: `GET /healthz` returns `{ ok: true }`.

**Stripe webhook:** after the first deploy, add a webhook endpoint in the
Stripe dashboard pointing at `https://$DOMAIN/api/shop/webhook` with event
`checkout.session.completed`, and set `STRIPE_WEBHOOK_SECRET` from the signing
secret.

## 4. Voice & video

Peer-to-peer WebRTC, signaling relay only — media never touches the server.
STUN-only ICE works for the majority of players; symmetric-NAT players (rare,
mostly corporate networks) will see a "direct link failed" badge. To add a TURN
relay, build the web client with:

```bash
VITE_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"c"}]'
```

Mic/camera access **requires HTTPS** — do not launch without the proxy profile.

## 5. Moderation

- Chat, emotes and reports are rate limited per socket (token buckets).
- Players can flag a seat with ⚑; the host gets a system message and the event
  lands in the structured server log (`player_report`) for review.
- Hosts can kick from the lobby or hand a live seat to the autopilot bot.
- Chat is room-scoped and expires with the room (no long-term storage).
- Roadmap (documented in the checklist): persistent block lists once accounts
  gain OAuth identity.

## 6. Operations notes

- **Logs**: structured JSON (`log.info/warn/error`) — ship stdout to your
  log platform. `player_report` and `shop_purchase` are the moderation/business
  events to alert on.
- **Backups**: Redis persistence covers rooms and cosmetics profiles; snapshot
  Redis at your usual cadence. Nothing else is durable.
- **Scaling**: rooms are single-node in memory; for multi-node, move to the
  Redis store plus a sticky-session load balancer (socket.io needs sticky
  routing for the HTTP long-polling fallback).
- **Updates**: `docker compose build && docker compose up -d` — persisted rooms
  restore from Redis on boot.
