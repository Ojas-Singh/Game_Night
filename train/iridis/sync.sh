#!/bin/bash
# Copy the rules core and the training code from this machine to Iridis.
#   train/iridis/sync.sh [host]        (default host: iridis-x3-26)
set -euo pipefail
host=${1:-iridis-x3-26}
here=$(cd "$(dirname "$0")/../.." && pwd)
ssh "$host" 'mkdir -p /scratch/$USER/gamelab'
rsync -a --delete --exclude target --exclude '__pycache__' --exclude '*.so' --exclude '.pytest_cache' --exclude '*.egg-info' \
  "$here/core" "$here/train" "$host":'/scratch/$USER/gamelab/'
