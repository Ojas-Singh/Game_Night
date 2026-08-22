# Game Night

An online multiplayer card-game platform — friends around one table, no accounts required.
Games: our house-rules **Cabo** and **Pair One** (a two-deck memory game).

## Quick start (local dev)

```bash
pnpm install
pnpm build                 # shared, engines, web, server
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
packages/shared         # card model, engine interface contract, seedable RNG
packages/engine-cabo    # server-authoritative Cabo rules engine (pure, heavily tested)
packages/engine-pairone # server-authoritative Pair One rules engine (pure, heavily tested)
apps/server             # rooms, presence, chat, tokens/reconnect, socket transport, debug API
apps/web                # React client (round-table Cabo + memory-grid Pair One, framer-motion)
```

- Networking talks only to the engine interface — adding a game never touches transport code.
  Register a new engine in `apps/server/src/room.ts` (`GAME_REGISTRY`) and route its view in the
  web client (views are discriminated by `gameId`).
- Per-player filtered views: hidden card values never leave the server.
- Debug endpoints (`/debug/*`) and the 🛠 overlay exist only in non-production builds.

## Tests

```bash
pnpm test   # 72 engine tests (Cabo + Pair One) + 30 server/transport (incl. full-game socket integration & persistence) + 20 web logic tests
```

## Deployment verification status

- Dockerfile **build stage** and **runtime stage** have each been replicated step-by-step outside Docker (frozen installs from manifests, all four package builds, prod-only boot with SPA + WebSocket + debug-404 verified, full games played E2E against the production tree).
- The literal `docker compose up -d` requires a Docker host: point Coolify at this repo, set `SESSION_SECRET`, expose port 3000.
