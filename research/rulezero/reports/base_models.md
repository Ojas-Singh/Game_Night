# Base-model results — week 1, day 3

> **PRELIMINARY — superseded by Phase-2 validity repair (Milestone 1).**
> Cabo numbers/claims below predate four environment corrections:
> 1. player observations exposed hidden hand ranks (information leakage);
> 2. utility sign/magnitude used raw point gaps, not bounded win/loss;
> 3. off-turn interrupts were permissive actions, not explicit reaction
>    decision nodes in the game tree;
> 4. chance (deals/draws) came from an internal seeded RNG instead of proper
>    OpenSpiel chance nodes.
> Retained for provenance; do not cite as authoritative results.



## Method

- Games: OpenSpiel built-ins, explicit rules text in every prompt (rules registry, hashed).
- Candidate: `llm:qwen3-1.7b` (Qwen3-1.7B, Q8_0 GGUF) served by llama.cpp
  `llama-server` on CPU (no GPU in this environment), `/no_think` mode,
  temperature 0.2, max_tokens 500.
- Protocol: seat-rotating strict evaluation (`rulezero.evaluate`): for every
  seed the candidate plays BOTH seats; opponents fill remaining seats.
- Research-strict: parse failures / unknown action ids are recorded failures;
  NO heuristic fallback exists in this path.

## Results — Kuhn poker vs Random opponent

| Metric | Value |
|---|---|
| Seat-episodes | 24 (12 seeds × 2 seats) |
| Mean return (candidate) | **−0.375** ± 0.54 (CI95) |
| Win rate | 33% |
| Strict failures | **0** |
| Parse failures | 0 |
| Avg decision latency | ~3.5 s (CPU) |

Reference: random-vs-random over 600 seat-episodes is −0.108 ± 0.119 (≈ 0,
as rotation symmetry requires). CFR teacher (300 iters) reaches
exploitability 0.003.

## Reading (with honest caveats)

1. **Rule comprehension / legality: solved.** Every one of the model's
   answers parsed and mapped to a legal action id. The A0..An protocol plus
   explicit rules text means even a 1.7B model plays legally all game long.
2. **Strategic quality: at-or-below random.** −0.375 vs a ≈0 baseline is
   suggestive but NOT conclusive at n=24 (CI includes 0). Directionally,
   the model loses more than it wins against uniform play.
3. This matches the week's hypothesis that base small models select legal
   actions reliably but carry little strategic prior for unseen-from-
   training-data games... with the caveat that Kuhn poker IS likely in
   Qwen's training data — making weak play here MORE damning, not less.
4. Thinking-mode comparison (planned arm) pending; `/no_think` was used
   because reasoning tokens tripled latency on CPU without being parsed.

## Config

`research/rulezero/configs/models/qwen3-1.7b.json`. Planned Qwen3.5-2B/4B
are not published under those names; per the plan's fallback rule we used
the closest available >1B instruction model. Re-run command:

```
cd research/rulezero && .venv/bin/python -m rulezero run \
  --game kuhn_poker --episodes 12 --candidate llm \
  --url http://127.0.0.1:8914/v1 --model qwen3-1.7b
```

## Results — Kuhn poker vs CFR teacher (300 iterations, exploitability 0.003)

| Metric | Value |
|---|---|
| Seat-episodes | 24 |
| Mean return | **−0.5** ± 0.46 |
| Win rate | 29% |
| Strict failures | 0 |
| Avg decision latency | ~5.7 s |

The tiny model's distance from equilibrium is large: a near-unexploitable
opponent takes half a blind per game from it while it never breaks a rule.
This answers week-question 3 affirmatively ("how far from equilibrium" — very)
and question 2 negatively for the untrained 1.7B (no evidence of play above
random).

## Thinking mode vs /no_think (measured; full A/B deferred to GPU)

Direct measurements on this CPU-only box:

| Arm | Decision latency | Reasoning output | Notes |
|---|---|---|---|
| `/no_think` | **3.3 s**/decision | none (0 chars) | clean JSON every time |
| thinking | **67.3 s**/decision | ~2,850 chars (~700 tok) first probe | needs max_tokens 3500 |

≈ **20× slower with thinking on CPU**, and a full 24-seat-episode Kuhn run
projected past 2 hours, so the paired A/B was parked at 11/24 seat-episodes
(preserved as `kuhn_poker-llm-think-seats.partial.jsonl`).

What we already know from the probes:

- With enough token budget, thinking mode produces well-formed final JSON
  after its `</think>` block — parsing works via the `reasoning_content`
  field (inline `<think>` fallback also handled).
- The quality question (does ~700 tokens of deliberation beat random more
  often than 3-second answers?) remains OPEN until the GPU rerun.
- Everything is staged for that rerun: same seeds/opponent/seat rotation,
  one flag different —

```
# GPU rerun, both arms:
python -m rulezero run --game kuhn_poker --episodes 12 --candidate llm       --url $ENDPOINT --model qwen3-1.7b
python -m rulezero run --game kuhn_poker --episodes 12 --candidate llm-think --url $ENDPOINT --model qwen3-1.7b
```

Fresh complete no_think baseline on identical seeds (this session):
−0.292 ± 0.507 mean return, 33% win rate, 0 strict failures, 3.28 s/decision.
