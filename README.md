# Game Night

Cards and drawing with friends — one room, no accounts required.
Games: our house-rules **Cabo**, **Pair One** (a memory game), and **Seep**
(the Punjab 2v2 fishing game — announce a bid, capture in groups, build
kachcha/pakka ghars, sweep the table; spades at face value, 100 points in the deck).
And the **Studio**: a shared canvas with pen-tablet brushes (see below).

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
- Env vars: `NODE_ENV`, `PORT`, `PUBLIC_URL`, `REDIS_URL`, `ROOM_TTL_MINUTES`, `SESSION_SECRET`, `RECONNECT_GRACE_MINUTES`, `LOG_LEVEL`, and for the trained player and the lab `GAME_MODEL_DIR`, `GAME_MODEL_SAMPLES`, `GAME_LAB_KEY` (see "AI players, self-play and the game lab").

Coolify: point a new Docker Compose resource at this repo; set `SESSION_SECRET`; expose port 3000.

### Public deployment with HTTPS (voice/webcam prerequisite)

Mic/camera access (`getUserMedia`) and payment webhooks require TLS. An
optional Caddy reverse proxy with automatic certificates ships behind a
profile — the default stack is unchanged:

```bash
DOMAIN=game.example.com ACME_EMAIL=you@example.com \
  docker compose --profile proxy up -d
```

Optional self-hosted, cookieless analytics (Umami):

```bash
docker compose --profile analytics up -d   # UI on :3001
```

Point the web build at it with `VITE_UMAMI_SRC=https://<host>/script.js` and
`VITE_UMAMI_WEBSITE_ID=<id>`; without them analytics is a compiled-in no-op
(see `apps/web/src/analytics.ts`). See `docs/LAUNCH_CHECKLIST.md` for the full
publication checklist (naming/trademark, moderation, funnels).

## Architecture

```
packages/shared         # card model, engine interface contract, seedable RNG
packages/engine-cabo    # server-authoritative Cabo rules engine (pure, heavily tested)
packages/engine-pairone # server-authoritative Pair One rules engine (pure, heavily tested)
packages/engine-seep    # server-authoritative Seep rules engine (pure, heavily tested)
apps/server             # rooms, presence, chat, tokens/reconnect, socket transport, debug API
apps/web                # React client (round-table Cabo, memory-grid Pair One, 2v2 Seep table, framer-motion)
```

- Networking talks only to the engine interface — adding a game never touches transport code.
  Register a new engine in `apps/server/src/room.ts` (`GAME_REGISTRY`) and route its view in the
  web client (views are discriminated by `gameId`).
- Per-player filtered views: hidden card values never leave the server.
- Debug endpoints (`/debug/*`) and the 🛠 overlay exist only in non-production builds.

## Studio (drawing together)

A room's host can open the studio from the lobby ("Draw together" tab), or anyone can start one
from the home page. Three modes: **Draw together** (one canvas), **Colour together** (the host's
picture sits on top as line art and fills stop at its lines) and **Side by side** (the same picture,
one canvas each, optionally hidden until the host reveals them). Pictures are uploaded by the host
or generated (mandala, flower, garden colouring pages).

- **Pen tablets:** pointer events with every coalesced sample, pressure (with a per-person pen-feel
  curve), tilt (pencil shading), the pen's eraser end, and the barrel button as the colour picker.
  Palm rejection: once a pen is seen, fingers only move the canvas. Two fingers pan/pinch/rotate;
  two-finger tap undoes, three-finger tap redoes. Holding the pen still at the end of a stroke snaps
  it to a straight line or an ellipse.
- **Brushes:** 30 stamp-based brushes (pencils, inks, paints, watercolour with wet edges, textures,
  airbrushes, fun stamps) with paper grain, plus layers (blend modes, opacity), bucket fill,
  symmetry guides, eight papers and PNG export. Keys: B/E/G/I tools, [ ] size, 1–9 opacity,
  Ctrl+Z / Ctrl+Shift+Z, Space-drag to pan, Ctrl+scroll to zoom, Tab hides the tools.
- **Sync:** every stroke, fill and clear is an op the server numbers (`apps/server/src/studio/`);
  clients replay ops in order with a deterministic brush engine (`apps/web/src/studio/engine/`).
  Fills travel as run-length masks so everyone paints the same pixels. Strokes in progress and
  cursors are relayed live but not stored. When a canvas passes 1,200 ops, one client flattens the
  older ones into a PNG per layer (`/api/studio/<room>/asset`), so late joiners load quickly.
  Pictures and flattened layers live in Redis next to the room (same expiry).

## Live voice & webcam

- **Voice + video at the table**: a full-mesh WebRTC call (server is a
  signaling relay only — media never touches it). Controls sit **inline next
  to each player's name** in the lobby roster — mic, camera, and live-state
  dots, no separate call box (the in-game table keeps a compact dock). When
  someone's camera is on, their **live feed replaces their avatar** in the
  roster and the seat pills. STUN-only by default; add a TURN relay via
  `VITE_ICE_SERVERS` for restrictive NATs.

- **Cosmetics (all free)**: card backs and felt themes — pick them in the
  lobby's **Table style** panel. Profiles are server-owned with a random
  bearer token in your browser (no account, no email, no tracking); equipped
  loadouts broadcast to the room and render on the table (per-player card
  backs, host's felt theme). Monetization was deferred — the
  Stripe plumbing was removed, and the catalog/profile model kept so a store
  can return without touching renderers or protocol. Plain-language `/privacy`
  and `/tos` pages ship with the client.

- **Peer-to-peer media mesh** for seated players in the lobby and at the table
  (full mesh WebRTC: ≤5 up/down streams per player; Opus audio ~32 kbps, video
  320×240@15fps only while the camera is on).
- The server is a **signaling relay only** (`media:join` / `media:signal` /
  `media:peers`): audio and video flow directly between browsers and are never
  recorded or proxied. Cameras are opt-in per join; everyone sees mic/cam
  states; kicked players leave the mesh with the room.
- Signaling is rate-limited per socket. ICE defaults to a public STUN server;
  set `VITE_ICE_SERVERS` (JSON array of RTCIceServer dicts) at build time to
  add a TURN relay later — some symmetric-NAT players (rare on home Wi-Fi,
  common on corporate networks) need it for direct links.
- HTTPS is required for microphone/camera access — see the Caddy profile above.

## AI players, self-play and the game lab

- **AI seats in live games**: the host clicks "AI seat" in the lobby. When
  `GAME_MODEL_DIR` points at an exported model (`player.onnx`, `judge.onnx`,
  `model.json`, written by `python -m gamelab_train.export`), the seat is
  played by the trained player with look-ahead search; `GAME_MODEL_SAMPLES`
  sets how many deals the search samples per move (0 turns the search off).
  Without a model, or for a game the model was not trained on, the seat is
  played by the built-in heuristic bot. AI turns go through the same action
  path as human moves, and the host can open the AI inspector at the table.
- **Rules core** (`core/`, Rust): one implementation of every game, built
  natively for self-play and search and as WASM for the server
  (`packages/core`). Every rule is a setting; `gameInfo()` lists them.
- **Self-play and training** are in `train/` (`gamelab_train`), and run on the
  cluster (`train/iridis/`), not on the web server.
- **Game lab** (`/lab`): choose a game, edit any rule, add rule sets, and
  measure them over the same deals. The table marks numbers that moved by at
  least 3 standard errors. Rounds can be played by random moves (mechanics
  only), by the trained player, or by the trained player with search. The lab
  is open in development; in production it is off unless `GAME_LAB_KEY` is
  set, and the page then asks for that key. Runs use the web server's CPU, one
  at a time, so long runs belong on the cluster:
  `python -m gamelab_train.lab cabo --sweep startingCards=4,6 --json out.json`
  writes a report that "Open a report file" on the lab page shows.
- **Packages**: `agent-core` (agent contract, legal-action enumeration,
  view serializers), `agent-bots` (random and heuristic bots).

## Tests

```bash
pnpm test
```

House rules are data: Seep's scoring table, sweep bonus and deal shape live in
`packages/engine-seep/src/rules.ts` (`SeepRules`) and are tunable without touching the engine.

## Deployment verification status

- Dockerfile **build stage** and **runtime stage** have each been replicated step-by-step outside Docker (frozen installs from manifests, all four package builds, prod-only boot with SPA + WebSocket + debug-404 verified, full games played E2E against the production tree).
- The literal `docker compose up -d` requires a Docker host: point Coolify at this repo, set `SESSION_SECRET`, expose port 3000.
