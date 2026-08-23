# RuleZero Week 1 Report

Branch: `research/rulezero-openspiel` · Base: production `main` (untouched)
Commits this week: `d8d970a` → `3bd0501` → `ec198ae` → `4f2d2bd` → (+ final)

## Architecture

Production (TS multiplayer site) untouched and green. Research moved into
`research/rulezero/` (Python, OpenSpiel-first) while the existing TS stack
remains the trajectory source for live games and hosts the hardened data
plane (trajectory schema v2). No TS "game kernel" was built — OpenSpiel owns
general game machinery per the architecture decision.

## OpenSpiel integration

- `open_spiel==2.0.2` wheel in an isolated venv (Python 3.13); no fork.
- Verified built-ins: kuhn_poker, leduc_poker, goofspiel, liars_dice.
- Thin wrappers only: CFRTeacher (solver loop), exploitability metrics,
  RandomTeacher/RandomAgent baselines, TeacherAgent (argmax play).
- Generic structural serializer + explicit hashed rules registry — no
  game-specific prompt code anywhere.

## Reproducibility

- All research randomness derives from explicit seeds (TS: clonable mulberry32
  inside EngineWorld; Python: per-(episode-seed, seat) streams).
- Same-config episodes are bit-identical (TS test) and same-seed summaries
  identical (Python test).
- Two measurement-caught validity bugs fixed and documented: constant-seeded
  agents correlate across episodes; seed-only streams stay seat-asymmetric
  for observation-blind agents. Kuhn random-vs-random now −0.108 ± 0.119
  over 600 seat-episodes (consistent with exact rotation symmetry).

## Trajectories

Schema v2 in both runtimes: provenance (schemaVersion, episodeId,
gameVersion/engineVersion, rulesHash, seatPermutation, agentConfigurations),
per-decision proposedAction vs executedAction, proposalWasLegal,
fallbackUsed/fallbackReason, observationHash, latencyMs. Raw files immutable;
teacher labels attach alongside student actions without mutating records.

Artifacts: arena recordings (`--record --raw`), seat-eval JSONLs under
`artifacts/evaluations/week1/`, teacher-labelled dataset at
`artifacts/datasets/labelled/kuhn_poker-cfr-300it.jsonl`
(30 episodes / 68 labelled decisions).

## Small-model experiment (day 3)

Qwen3-1.7B-Q8_0 served locally by llama.cpp `llama-server` on CPU behind an
OpenAI-compatible endpoint (`/no_think`, temp 0.2). Config:
`configs/models/qwen3-1.7b.json`. Planned Qwen3.5-2B/4B are unpublished; the
plan's >1B fallback rule applied. Full numbers in `reports/base_models.md`.

Headlines (Kuhn poker, strict mode, seat-rotated):
| Opponent | Mean return | Win rate | Strict failures |
|---|---|---|---|
| Random | −0.375 ± 0.54 | 33% | **0** |
| CFR teacher (expl. 0.003) | −0.5 ± 0.46 | 29% | **0** |

Legality is solved by the protocol (A0..An ids): 100% parse/legal across all
runs. Strategy of the untrained 1.7B is at-or-below random and far from
equilibrium — exactly why solver supervision (day 4) matters.

## Strategic baseline

CFR on Kuhn reaches exploitability 0.003 in 300 iterations through our thin
wrapper. Teacher-labelled trajectories exist end-to-end
(`python -m rulezero label ...`), giving the SFT stage real supervision
instead of winner-only filtering.

## Training readiness

QLoRA script has assistant-only masking (CPU-tested pure function), action-id
targets supported in the dataset builder (action-only default), episode-safe
splits/dedup. A 2B LoRA smoke run launches as soon as GPU compute exists;
data path already validated CPU-side (v2 recording → action-only samples).

## Performance (rough, this machine)

llama.cpp CPU: Qwen3-1.7B ≈ 3.5–5.7 s per decision (~25 tok/s generation).
OpenSpiel random episodes: >100/s single process. CFR 300 iters Kuhn: seconds.

## Failures and honest gaps

- **Cabo OpenSpiel environment: DONE for 2 players, differentially verified.**
  `rulezero/cabo_env.py` replicates the TS engine bit-exactly: same
  splitmix32+xoshiro128** RNG and Fisher-Yates shuffle (identical deals from
  identical seeds), all phases, mandatory powers with TS skip conditions,
  off-turn flush interrupts (own subsets + other, blocked only during
  TRANSFER_PENDING per TS), wrong-flush reveal/penalty semantics, transfer
  restore, empty-deck reshuffle through the SAME rng stream, Cabo call
  (single-call guard), zero-card auto-Cabo, caller exclusion +
  othersFinalTurns budget, end-round full reveal, black-K/red-K scoring,
  caller tiebreak. `rulezero/diff_cabo.py` drives BOTH engines through
  identical random episodes comparing 12 semantic fields after EVERY action:
  390/390 episodes verified (seed ranges 1, 100000, 500000) + 8 unit tests.
  Divergences found & fixed by the harness: end-round reveal missing,
  off-turn flush mutating wrong actor, re-callable Cabo extending games
  forever.
- Remaining Cabo scope: 3–6 player seats (mechanics are seat-generic; the
  differential bridge currently fixes 2), and exposing Cabo through the
  rules registry/serializer for LLM seats.
- Thinking-mode arm of the model comparison: infrastructure DONE and verified
  (reasoning_content extraction, inline <think> fallback, 3500-token budget,
  per-decision reasoning-length metrics); CPU cost measured at ~20x latency
  (67 s vs 3.3 s per decision) making the full paired A/B impractical locally
  -> deferred to GPU. Rerun commands staged in reports/base_models.md.
- Pair One in OpenSpiel: intentionally skipped per plan priorities.

## GameSpec v0 (started)

`rulezero/gamespec_schema.py`: bounded validated schema, canonical JSON +
sha1 spec hash, auto-generated rules text. `rulezero/gamespec_compile.py`:
compiles a spec into a registered OpenSpiel python game (chance deals seeded
from game parameters — injectable for later differential work). Seed spec
`specduel` passes 400-episode fuzz (all terminal, exactly zero-sum) and is
same-seed deterministic.

## Next experiments ranked by expected scientific value

1. Cabo in OpenSpiel + differential vs TS engine (unlocks custom-game claim).
2. SFT Qwen3-1.7B on CFR-labelled Kuhn trajectories (pipeline proof; CPU LoRA
   via llama.cpp train? or wait for GPU — dataset is ready).
3. Thinking-vs-no-think arms with proper token budgets.
4. Leduc CFR blueprint + labelling (beyond tiny-Kuhn evidence).
