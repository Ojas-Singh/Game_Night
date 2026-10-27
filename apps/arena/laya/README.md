# Laya for Cabo

Trains [Laya](https://huggingface.co/convaiinnovations/laya) (a 421M ModernBERT decision
model: table text + typed questions → option probabilities) to play Cabo.

## How it works

- **Teacher** (`teacher.mjs`): heuristic bots play games; at every decision each legal move is
  scored by 128 rollouts — re-deal the cards that seat cannot see, apply the move, play the round
  out with heuristic bots, average the payoff (0.8 × win + 0.2 × score margin). Soft targets are
  `softmax(Q / 0.05)`. Moves are capped at 20 options (Laya's limit); J/Q swaps with more options
  are asked as `move` / `give` / `take` questions. All of this lives in `cabo-common.mjs`, which
  play uses too, so training and play see identical text.
- **Training** (`train_cabo.py`, Slurm: `train_cabo.sbatch`): `laya.train.finetune` from
  `convaiinnovations/laya`, RLCD loss, option-order shuffling, 2 epochs, max_len 160.
- **Evaluation** (`eval.mjs`): seat p0 is the agent, other seats the built-in heuristic bot.
  `laya_server.py` serves a checkpoint at `POST /decide`.

```bash
node teacher.mjs train-raw.jsonl 11000 16 128 1          # ~12 min on 16 cores, ~106k rows
sbatch train_cabo.sbatch                                  # ~25 min on one A100
python laya_server.py --model ./ckpt-cabo-v1 --port 8766
node eval.mjs laya:http://127.0.0.1:8766 1000 8 3
```

## Results (ckpt-cabo-v1, 2026-10-25)

Win rate of seat p0 against built-in heuristic bots (ties split), 95% Wilson interval:

| players | heuristic in p0 | teacher (64 rollouts) | Laya v1 |
|---|---|---|---|
| 2 | 49.3% [47.1, 51.5] | | **61.3%** [57.4, 65.2] |
| 3 | 29.3% [27.7, 30.9] | 38.2% [34.4, 42.1] | **40.2%** [37.2, 43.3] |
| 4 | 21.9% [20.2, 23.8] | | **28.6%** [25.1, 32.3] |

Held-out decisions (last 1,000 games): top-1 agreement with the teacher's best move rose from
33.6% (base Laya) to 57.7%. The untrained model wins 0/30. Latency per decision: ~28 ms on a GB10
GPU, ~0.55 s on 2 CPU threads; ~3 GB RAM.

## Trick suite (`tricks.mjs`)

Win rate hides *which* skills a model has. `tricks.mjs` builds 19 positions that each test one trick (flush own /
pair / opponent's known card, give away the highest card on a transfer, keep low / discard high, 7-8 and 9-10 peeks
on unseen cards, J/Q swaps, calling and not calling Cabo) across 2, 3 and 4 players, and asks the agent for p0's
move. Five are marked `memory`: they need table history that prompt version 1 does not show (card counting from the
discard pile, a rank whose other three cards are gone, an opponent who kept drawn cards into slots, a card an
opponent peeked).

Each position is a real seeded game edited consistently: cards only swap rank/suit (52-card multiset kept), p0's
knowledge is set exactly, the event log is rewritten to match, and engine actions reach the phase under test. The
declared right move is checked by 1024 determinized rollouts with de-biased heuristic bots (random choice among
equally unknown slots and tied victims; p0 calls Cabo only at an estimated total of 10 or less). Status `agree` /
`weak` (within 2 SE) is scored, `disagree` is listed and skipped.

```bash
node tricks.mjs --check                                  # construction checks + validation table (~25 s)
node tricks.mjs http://127.0.0.1:8800 --batch            # Laya on batch_server.py (add #p2 for a prompt-v2 model)
node tricks.mjs heuristic                                # baselines; teacher:256 = eval.mjs's rollout teacher
node tricks.mjs teacher:256 --json out.json --show       # per-move values and the text the model reads
```

Results (2026-10-27, 18 scored scenarios; `give-peeked-card` disagrees with the rollouts and is skipped):

| agent | all | non-memory (14) | memory (4) | mean P(right) |
|---|---|---|---|---|
| Laya v3 (prompt 1) | **15/18** | 13/14 | 2/4 | 58% (63% / 40%) |
| heuristic bot | 12/18 | 12/14 | 0/4 | |
| teacher (256 plain rollouts) | 13/18 | 10/14 | 3/4 | |

Laya v3 misses: give the known Q (not the unknown card) for an opponent's known 2; take the slot an opponent just
kept a card in; do not call Cabo on 10 against an opponent who kept four drawn cards. The plain-heuristic teacher
keeps a drawn red K over an ace (an artifact: the heuristic's J/Q swap always takes the victim's slot #1).
