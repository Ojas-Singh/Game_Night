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

## Next (Milestone 2)
- 3–6 player differential coverage; compliance suite; 10k-episode validation.
