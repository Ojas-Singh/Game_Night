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
