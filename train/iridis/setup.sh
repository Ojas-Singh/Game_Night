#!/bin/bash
# One-time setup on Iridis X, run on a login node from /scratch/$USER/gamelab/train/iridis.
# Everything goes under /scratch/$USER/gamelab (the home directory has a small file quota).
set -euo pipefail
root=/scratch/$USER/gamelab
export RUSTUP_HOME=$root/rust/rustup CARGO_HOME=$root/rust/cargo
if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
fi
export PATH=$CARGO_HOME/bin:$PATH
[ -d "$root/env" ] || uv venv --managed-python --python 3.12 "$root/env"
source "$root/env/bin/activate"
uv pip install torch numpy maturin pytest onnx onnxruntime
(cd "$root/core/gamelab-py" && maturin develop --release)
uv pip install -e "$root/train" --no-deps
(cd "$root/core" && cargo test --release)
(cd "$root/train" && python -m pytest -q)
