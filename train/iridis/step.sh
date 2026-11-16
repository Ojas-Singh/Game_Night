#!/bin/bash
# A training run inside an allocation that is already running:
#   srun --jobid=<job> --overlap -n1 -c24 --gres=gpu:1 bash step.sh <config.json> <run name>
set -euo pipefail
root=/scratch/$USER/gamelab
source "$root/env/bin/activate"
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export RAYON_NUM_THREADS=24 OMP_NUM_THREADS=4
cd "$root/train"
exec python -m gamelab_train.train --config "$1" --out "$root/runs/$2"
