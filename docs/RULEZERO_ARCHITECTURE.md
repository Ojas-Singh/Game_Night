# RuleZero Architecture

Status: living document (Phase-2). Owner: research branch
`research/rulezero-openspiel`.

## The five layers (and what each is FOR)

```
GameSpec        semantic source for generated games
   ↓            (data-only IR; validated; SHA-256 hashed)
OpenSpiel       strategic/runtime substrate
                (chance nodes, information states, CFR/MCCFR, exploitability)
   ↓
RuleZero        intelligence/training system
                (teachers, trajectories, active learning, model backends)
   ↓
Game Night TS   product/orchestration/UI
                (rooms, sockets, presence, accounts, human play)
   +
Tinker / local GPU   interchangeable model compute
                     (behind ModelBackend; never embedded in env code)
```

## Non-negotiables

1. **One canonical semantic implementation per game.** New games are written
   ONCE as a GameSpec and interpreted by the generic runtime. No TypeScript +
   Python twin engines for new games.
2. **The LLM never becomes the runtime.** LLMs may compile rules → GameSpec;
   the deterministic interpreter executes them.
3. **Environment code never imports model providers** (Tinker, llama.cpp,
   HF). Backends are pluggable adapters.
4. **Research validity gates before training**: no hidden-info leakage,
   bounded correct utilities, explicit chance semantics, real reaction-window
   decision nodes, perfect-recall information states, compliance suite green.

## Current implementation map (research branch)

| Path | Role |
|---|---|
| `research/rulezero/rulezero/cabo_env.py` | canonical stochastic Cabo (2-6p), §3-§7 repaired |
| `apps/arena/src/caboBridge.ts` + `diff_cabo.py` | differential parity vs legacy TS engine |
| `rulezero/gamespec_ir.py` | GameSpec v1 IR: validation, canonical JSON, SHA-256 |
| `rulezero/gamespec_runtime.py` | ONE generic OpenSpiel interpreter for any IR spec |
| `rulezero/compliance.py` | §12 acceptance suite every game must pass |
| `rulezero/serialize.py`, `recorder.py`, `agents.py` | dense candidate ids (A0..An), trajectories with candidateId+environmentActionId |

## Migration policy (existing TS engines)

Stage A (now): TS Cabo = production, OpenSpiel Cabo = research twin.
Stage B ✅: canonical OpenSpiel Cabo corrected; differential parity proven.
Stage C-F: feature flag → A/B → authoritative → retire duplicate logic.
Pair One stays TS until there is a reason to migrate. NEW games never create
the duplication.

## Acceptance gates (test-first, §32)

A phase is done only when its tests pass — see the master plan §32. Cabo's
gates are all green as of Phase-2 Milestone 2; GameSpec runtime gates green
as of Milestone 3 except long-tail validator matrix items.
