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
