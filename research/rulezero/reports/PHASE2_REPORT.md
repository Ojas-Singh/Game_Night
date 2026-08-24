# RuleZero Phase 2 Report (living document)

## Milestone 1 — validity repair: DONE

| Item | Status | Evidence |
|---|---|---|
| Sync main → research branch | ✅ `8da7890` | typecheck/build/156 TS tests green; python suites green |
| Week-1 results frozen PRELIMINARY | ✅ | headers in WEEK1_REPORT.md / base_models.md |
| Hidden-info leakage fixed (§3) | ✅ | private observations; adversarial suite incl. cross-state leak fuzz (`test_cabo_info.py`) |
| Bounded utility (§4) | ✅ | ±1/0 with caller tiebreak; raw points kept in `final_scores`; unit scenarios |
| Dense candidate ids (§8) | ✅ | prompts show A0..An; `candidate_map`; trajectories carry `candidateId` |
| Info-state priority (§7) | ✅ | serializer prefers `information_state_string`; indistinguishable-worlds test |
| Reaction windows as decision nodes (§5) | ✅ | deterministic seat-order PASS/flush windows; traversal proven by window counters in fuzz + differential |
| Explicit chance semantics (§6) | ✅ | deals/draws/penalties are uniform chance nodes over the remaining pool; NO internal RNG; discard recycle is public |

Differential parity after rebuild: 66/660 episodes verified (seeds 1+, 20000+),
comparing phase/hands/pool/discard/drawn/pending/cabo/knowledge after every
applied action. One engine, two sampling modes: OpenSpiel chance sampling
(canonical) and TS-exact replay via driver card-feeding.

## Milestone 2 — Cabo validation: core gates green (in progress)

| Item | Status | Evidence |
|---|---|---|
| 2–6 player support | ✅ | `CaboGame({"players": N})`; game info/type sized by params; returns() n-sized |
| Multi-player differential | ✅ 360/360 | 2p×150, 3p×80, 4p×60, 5p×40, 6p×30 (seeds 30000+) vs TS engine |
| OpenSpiel compliance suite | ✅ | `compliance.py` + `test_compliance.py`: PASS at 2/4/6 players — chance sums to 1, legal actions apply on clones, garbage rejected, clone exact+isolated, finite returns, no terminal decisions, deterministic replay, privacy hook |
| Exact clone | ✅ | deep-copy `clone()` verified mutation-isolated mid-game |
| Reproducible env (§20) | ✅ | open_spiel pinned ==2.0.2 |

Cumulative post-rebuild differential parity: **426 episodes** across seed
families {1+, 20000+, 30000..70000+}. Remaining toward the 10k target:
long-horizon soak runs (background job), plus config toggles
(swapOthers off / empty-deck / zero-card auto-Cabo) as fixtures.


---

# PHASE 3A — Playable Game Lab + GPU-Ready Platform

### Round 15: Game Lab foundation ✅

`rulezero/gallery.py`: **8 mechanically distinct GameSpec games** — Kuhnish
Duel, Mini Bluff, Hidden Duel, Prize Bidding, Secret Bid, Counter Claim,
Reveal or Hold, Double or Nothing — every one pure data run by the ONE
interpreter, with UI-safe capability tags and typed mutation grids
(mini-bluff: 3 decks × 3 bet sizes = 9 valid distinct variants).

`rulezero/lab.py`: Simulation Lab runner — deterministic CPU agents
(random/first; solver registry slot ready), per-seat win%/ties/avg returns/
mean length/decisions per game, hard episode cap, zero-sum asserted for
every gallery game.

Two spec bugs caught and fixed during bring-up (empty-deck prize flip in
secret-bid; degenerate self-compare award in reveal-hold) — exactly the
class of issue the pipeline exists to surface.

Gates: test_gallery.py (15). Totals: 90 pytest + legacy suites green.

### Round 16: Game Lab visible on the website ✅

- Service gains stateless lab ops: `labCatalog` / `labGet` / `labVariant` /
  `labSimulate` — same line-JSON protocol, validated variants, capped
  episodes.
- `apps/server/src/gameLab.ts`: one shared lab subprocess client
  (strictly-ordered, auto-restart) + REST routes `/api/lab/games`,
  `/api/lab/games/:id`, `/api/lab/variant`, `/api/lab/simulate`; express.json
  added. Live play still flows through per-room rulezeroEngine sessions.
- `apps/web/src/pages/GameLabPage.tsx`: gallery cards with capability tags +
  spec hashes; per-game Simulation Lab panel (episode count → win%/ties/
  returns/length) hitting the real service; home page gains a Game Lab link;
  product-styled CSS.
- Verified LIVE: built server + curl → catalog JSON, variant simulation
  (mini-bluff ranks1-5/bet2: P0 100% vs first-agent), claim base game sim.
  Workspace tests all green (37+12+9+7).


### Round 17: Solver visible on the website ✅

- `labStrategySamples` service op + `GET /api/lab/games/:id/strategy`:
  labeled candidate distributions (§8 labels, never raw A0/A1) at sampled
  decision points, NashConv exploitability, states solved.
- GameLabPage: per-seat agent pickers (CFR/Random/First), strategy inspector
  panel with probability bars and a hidden-info safety note; solver runs
  on demand with caching.
- Verified LIVE: kuhnish strategy endpoint (check 99.7% with low card,
  bet 99.8% with high card; NashConv 0.0041) and CFR-vs-Random claim
  simulation through the REST API. 98 pytest + workspace tests green.


### Round 18: Generated games are playable in live rooms ✅

- One-shot spec staging: POST /api/lab/games/:id/room resolves a gallery
  variant to a validated spec and returns a consume-once token;
  Room carries it and dealNewGame feeds the resolved spec into
  RuleZeroEngine.createGame (no TS engine code per game — §6).
- Web: Play button on every gallery card stages the spec and routes through
  the normal create-room flow; socket room:create accepts rulezeroSpecToken.
- Verified LIVE end-to-end: mini-bluff variant staged -> socket room:create ->
  room 4RAPVV created -> second player joined -> RuleZero service session
  started cleanly. All workspace suites + web build green.


### Round 19: CPU AI seats join live generated games ✅

- Service op aiChoose: picks for the CURRENT actor of a live session
  (CFR via cached policy or random; chance steps resolve internally) using
  only the actor's information state.
- rulezeroEngine: setAiSeats/currentPlayerId/chooseAiAction; persona->kind
  mapping (balanced/strong/solver => CFR) at deal time.
- agents/loop: polling pump (actRulezero) waits for service readiness,
  drives AI turns through the SAME authority path as humans, stops at
  human turns/terminal; notifyHook re-broadcasts when the async python
  session settles (fixes the spawn/broadcast race).
- Verified LIVE: human + AI played mini-bluff to terminal in a real room
  (views=4, humanActs=2, scores {0:+1,1:-1}). All suites green.
