# Game Night

An online multiplayer card-game platform — friends around one table, no accounts required.
Games: our house-rules **Cabo**, **Pair One** (a memory game), and **Seep**
(the Punjab 2v2 fishing game — announce a bid, capture in groups, build
kachcha/pakka ghars, sweep the table; spades at face value, 100 points in the deck).

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
publication checklist (naming/trademark, Stripe, moderation, funnels).

### Rules → Play compiler

Game Lab keeps model access on the server and sends only validated GameSpec data
to the runtime. For a generic OpenAI-compatible gateway set
`RULEZERO_COMPILER_URL`, `RULEZERO_COMPILER_MODEL`, and optionally
`RULEZERO_COMPILER_API_KEY`. OpenCode Go is supported directly: set
`OPENCODE_API_KEY` (and optionally `OPENCODE_GO_MODEL`, default
`mimo-v2.5`). The adapter uses OpenCode Go's OpenAI-compatible endpoint at
`https://opencode.ai/zen/go/v1`, sends a stable `x-opencode-session` per compile
job, and identifies itself as `gamenight-rulezero/1.0`. Set
`RULEZERO_COMPILER_PROVIDER=opencode-go` to select Go explicitly when using a
custom base URL (`OPENCODE_GO_BASE_URL`). The same key automatically enables
OpenCode Go for Cabo's optional live LLM seats; explicit `AGENT_*` settings take
precedence (`AGENT_PROVIDER=opencode-go` preserves Go session routing when a
custom `AGENT_API_URL` is supplied). The CPU Torch learner remains the
trainable checkpoint path.

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

## Live voice & webcam

- **Cosmetics shop** (`/shop`): card backs and table felts — starter items free,
  some unlock by rounds played (server-awarded, capped), paid items through
  Stripe Checkout. Entitlements are server-owned (a sku not in your inventory
  can never be equipped); identity is a random bearer token in your browser —
  no account, no email, no tracking. Equipped loadouts broadcast to the room
  and render on the 3D table (per-player card backs, host's felt theme) and
  the 2D felt. Configure with `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  (webhook: `POST /api/shop/webhook`), and `APP_ORIGIN`. Plain-language
  `/privacy` and `/tos` pages ship with the client.

- **3D table (opt-in)**: the Cabo table can render as a real three.js scene —
  felt, fanned card hands, deck/discard piles, flight ghosts, turn rings — via
  a `✦ 3D` toggle. It lazy-loads as its own bundle (three.js never enters the
  main chunk), respects reduced-motion/low-core devices, and the classic 2D
  table remains one click away as the fallback. Both renderers share the same
  layout math and the same click-intent logic, so gameplay is identical.

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

## AI players & self-play

- **AI seats in live games**: the host clicks "Seat AI" in the lobby and picks a
  persona (Balanced / Baiter / Conservative / Aggressor / Scholar). AI turns run
  through the server's agent loop with human-like think delays. Without any
  model configured they use built-in heuristic bots; point `AGENT_API_URL`
  (OpenAI-compatible: vLLM, Ollama, …), `AGENT_API_KEY`, `AGENT_MODEL` at your
  own GPU box to make them LLM-driven.
- **Self-play arena** (`apps/arena`): headless engine-level episodes with an
  ELO ladder and JSONL trajectory recording:

  ```
  pnpm --filter @game-night/arena arena --game pairone --episodes 200 \
      --seats heuristic,heuristic,random --record
  ```

- **Packages**: `agent-core` (agent contract, legal-action enumeration,
  view serializers, trajectory recorder), `agent-bots` (random, heuristics,
  flat Monte-Carlo search over a `SearchWorld` port), `agent-llm` (persona
  prompts + strict-JSON action protocol with corrective retry and heuristic
  fallback).
- **Self-play training loop** (`apps/trainer`, runs on your own GPU box):

  ```
  # 1. record episodes with raw views
  pnpm --filter @game-night/arena arena --game pairone --episodes 500 \
      --seats llm,llm,heuristic --record --raw --out trajectories

  # 2. build SFT dataset (winner moves only, deduped, chat format)
  pnpm --filter @game-night/trainer dataset --in trajectories/pairone-episodes.jsonl \
      --out sft-data --include-bots

  # 3. QLoRA fine-tune (transformers+peft+bitsandbytes, ~32 GB card)
  cp apps/trainer/python/train.config.example.json train.config.json  # edit it
  pnpm --filter @game-night/trainer train --config train.config.json

  # 4. serve the adapter and evaluate head-to-head vs bots
  vllm serve Qwen/Qwen3-8B --enable-lora --lora-modules gen1=adapters/gen1
  pnpm --filter @game-night/trainer eval --url http://localhost:8000/v1 \
      --model gen1 --game pairone --episodes 20 --opponent heuristic
  ```

  Training prompts are byte-identical to live inference prompts (shared
  `buildLlmPrompt`), so the model improves at exactly the task the server
  asks of it. Each generation: record → filter winners → tune → eval →
  repeat; the arena ELO ladder tracks progress across generations.

## Tests

```bash
pnpm test   # 188 core tests — 100 engine (Cabo + Pair One + Seep, incl. exhaustive Seep legal-action parity fuzz) + 44 server/transport (incl. full-game socket integration & persistence) + 44 web logic — plus agent (16), arena (12) and trainer (9) suites
```

House rules are data: Seep's scoring table, sweep bonus and deal shape live in
`packages/engine-seep/src/rules.ts` (`SeepRules`) and are tunable without touching the engine.

## Deployment verification status

- Dockerfile **build stage** and **runtime stage** have each been replicated step-by-step outside Docker (frozen installs from manifests, all four package builds, prod-only boot with SPA + WebSocket + debug-404 verified, full games played E2E against the production tree).
- The literal `docker compose up -d` requires a Docker host: point Coolify at this repo, set `SESSION_SECRET`, expose port 3000.
