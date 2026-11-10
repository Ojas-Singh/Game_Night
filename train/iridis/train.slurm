#!/bin/bash
# A training run on one GPU of Iridis X. A run that hits the time limit is
# continued by submitting the same command again.
#   sbatch train/iridis/train.slurm <config.json> <run name>
#SBATCH --job-name=gamelab
#SBATCH --partition=a100
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=24
#SBATCH --mem=120G
#SBATCH --time=2-12:00:00
#SBATCH --output=/scratch/%u/gamelab/runs/%x-%j.out
set -euo pipefail
root=/scratch/$USER/gamelab
source "$root/env/bin/activate"
export RAYON_NUM_THREADS=$SLURM_CPUS_PER_TASK OMP_NUM_THREADS=4
cd "$root/train"
python -m gamelab_train.train --config "$1" --out "$root/runs/$2"
