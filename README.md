# Game Night

An online multiplayer card-game platform — friends around one table, no accounts required. First game: our house-rules **Cabo**.

## Quick start (local dev)

```bash
pnpm install
pnpm build                 # shared, engine, web, server
pnpm --filter @game-night/server dev   # server on :3000 (debug mode on)
pnpm --filter @game-night/web dev      # client on :5173 (proxies sockets)
```

## Production (Docker / Coolify)

```bash
docker compose up -d
```

- Single `app` container serves the built web client and the Socket.IO server (WebSockets work through the Coolify proxy).
- `redis` for future horizontal scaling; playing needs no database.
- Env vars: `NODE_ENV`, `PORT`, `PUBLIC_URL`, `REDIS_URL`, `ROOM_TTL_MINUTES`, `SESSION_SECRET`, `RECONNECT_GRACE_MINUTES`, `LOG_LEVEL`.

Coolify: point a new Docker Compose resource at this repo; set `SESSION_SECRET`; expose port 3000.

## Architecture

```
packages/shared       # card model, engine interface contract, seedable RNG
packages/engine-cabo  # server-authoritative Cabo rules engine (pure, heavily tested)
apps/server           # rooms, presence, chat, tokens/reconnect, socket transport, debug API
apps/web              # React round-table client (2.5D DOM, framer-motion)
```

- Networking talks only to the engine interface — adding a game never touches transport code.
- Per-player filtered views: hidden card values never leave the server.
- Debug endpoints (`/debug/*`) and the 🛠 overlay exist only in non-production builds.

## Tests

```bash
pnpm test   # 44 engine tests + 16 server/transport tests incl. full-game socket integration
```
