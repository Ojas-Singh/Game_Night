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
pnpm test   # 187 core tests — 104 engine (Cabo + Pair One + Seep) + 44 server/transport (incl. full-game socket integration & persistence) + 39 web logic — plus agent (16), arena (12) and trainer (9) suites
```

House rules are data: Seep's scoring table, sweep bonus and deal shape live in
`packages/engine-seep/src/rules.ts` (`SeepRules`) and are tunable without touching the engine.

## Deployment verification status

- Dockerfile **build stage** and **runtime stage** have each been replicated step-by-step outside Docker (frozen installs from manifests, all four package builds, prod-only boot with SPA + WebSocket + debug-404 verified, full games played E2E against the production tree).
- The literal `docker compose up -d` requires a Docker host: point Coolify at this repo, set `SESSION_SECRET`, expose port 3000.
