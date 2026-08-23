# OpenSpiel Inventory — RuleZero week 1

Environment: Python 3.13.5, venv at `research/rulezero/.venv`,
`open_spiel==2.0.2` (PyPI wheel; no fork, no source build).

## Built-in games verified working

| Game | Players | Dynamics | Chance | Information | Utility | Notes |
|---|---|---|---|---|---|---|
| kuhn_poker | 2 | SEQUENTIAL | EXPLICIT_STOCHASTIC | IMPERFECT_INFORMATION | ZERO_SUM | tiny bluffing lab; exact CFR solvable |
| leduc_poker | 2 | SEQUENTIAL | EXPLICIT_STOCHASTIC | IMPERFECT_INFORMATION | ZERO_SUM | two-round betting; blueprint-scale |
| goofspiel | 2 | SIMULTANEOUS | EXPLICIT_STOCHASTIC | PERFECT_INFORMATION* | ZERO_SUM | *bid deck hidden → practically imperfect-info; simultaneous bids |
| liars_dice | 2 | SEQUENTIAL | EXPLICIT_STOCHASTIC | IMPERFECT_INFORMATION | ZERO_SUM | claims/bluffs; inference about unseen dice |

Random-vs-random sanity through our seat-rotating runner (20/10 episodes):
kuhn mean return 0.05 ± 0.47 (theory ≈ 0); all four games complete with zero
strict failures. First-run lesson recorded below.

## Algorithms available (to be wrapped, NOT reimplemented)

- `pyspiel` exposes policy/solver machinery per game: expected-useful for us:
  - **CFR / outcome-sampling MCCFR** via `open_spiel.python.algorithms.cfr` /
    `expected_game_score`, exploitability via
    `open_spiel.python.algorithms.exploitability` (perfect for Kuhn/Leduc).
  - **MCTS / IS-MCTS** (`open_spiel.python.algorithms.mcts`) with chance
    sampling for imperfect-information games.
  - **Best-response** computation (`best_response`) for exploitative analysis.
  - Tabular policies (`TabularPolicy`) as uniform/baseline references.
- Full inventory to be enumerated programmatically in a follow-up pass
  (`pyspiel.registered_names()` count at time of writing: ~100+ games).

## API notes discovered (OpenSpiel 2.x)

- `GameType.short_name` carries the game id (`Game.get_name()` does not exist
  in the Python bindings).
- Game metadata: `game.get_type()` fields `.dynamics/.chance_mode/
  .information/.utility` (enum `.name` strings used in trajectories).
- `state.observation_string(player)` preferred; fall back to
  `information_state_string(player)` then public history.
- Chance nodes are explicit: sample from `state.chance_outcomes()`.
- `state.action_to_string(player, aid)` gives human-readable action text —
  used directly in prompts and trajectory records.

## First-run lesson (recorded honestly)

Our first evaluation run showed random-vs-random Kuhn at a constant −1.0 for
both seats. Cause: agents were seeded with FIXED constants shared across all
episodes, creating correlated degenerate opponents. Fix: every agent RNG must
be derived from the episode seed (documented in `evaluate.py`). Reproducible
does not mean frozen — same config reproduces, different episodes vary.

## Integration status

- [x] pyspiel imports; four target games load and play
- [x] rules registry with hashed explicit rules text (no memorized-rules play)
- [x] generic structural serializer (metadata + rules + view + A0..An ids)
- [x] strict OpenAI-compatible agent (parse/legal metrics; no fallback)
- [x] seat-rotating evaluator returning mean return ± CI95, by-seat splits
- [x] trajectory recorder aligned with TS schema v2 (JSONL, immutable)
- [ ] teacher wrappers (CFR/exploitability/MCTS) — next checkpoint
