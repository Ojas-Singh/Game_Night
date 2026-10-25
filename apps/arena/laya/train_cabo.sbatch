#!/bin/bash
#SBATCH --job-name=laya-cabo
#SBATCH --partition=a100
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=48G
#SBATCH --time=24:00:00
#SBATCH --output=/scratch/os1e26/laya-cabo/logs/%x-%j.out
# Fine-tune Laya on Cabo teacher data (rollout win rates as soft targets).
set -euo pipefail
cd /scratch/os1e26/laya-cabo
. .venv/bin/activate
export HF_HOME=/scratch/os1e26/laya-cabo/hf HF_HUB_OFFLINE=1 USE_TF=0 PYTHONUNBUFFERED=1
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
python train_cabo.py --data train.jsonl --eval eval.jsonl --out ckpt-cabo-v1 \
  --epochs 2 --micro 32 --accum 2 --max-len 160 --head-max-len 256
