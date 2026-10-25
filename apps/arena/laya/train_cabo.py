"""Fine-tune Laya on Cabo teacher data (soft targets from rollout win rates)."""
import argparse, os, time
os.environ.setdefault("USE_TF", "0")
from laya.train import TrainConfig, finetune, resolve_checkpoint_dir

ap = argparse.ArgumentParser()
ap.add_argument("--data", required=True)
ap.add_argument("--eval", default=None)
ap.add_argument("--out", required=True)
ap.add_argument("--base", default="convaiinnovations/laya")
ap.add_argument("--epochs", type=int, default=2)
ap.add_argument("--micro", type=int, default=32)
ap.add_argument("--accum", type=int, default=2)
ap.add_argument("--max-len", type=int, default=160)
ap.add_argument("--head-max-len", type=int, default=256)
ap.add_argument("--checkpointing", action="store_true")
ap.add_argument("--loss", default="rlcd")
a = ap.parse_args()
cfg = TrainConfig(epochs=a.epochs, micro_batch=a.micro, grad_accum=a.accum, max_len=a.max_len,
                  head_max_len=a.head_max_len, gradient_checkpointing=a.checkpointing, loss=a.loss,
                  shuffle_options=("choice",), eval_data=a.eval, log_every=200)
t = time.time()
finetune(a.data, resolve_checkpoint_dir(a.base), a.out, config=cfg)
print(f"wall {time.time() - t:.0f}s")
