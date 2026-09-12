#!/usr/bin/env bash
# Run ON your laptop. Forwards local :8000 → Lambda vLLM :8000 over SSH.
# Usage:
#   ./tunnel.sh ubuntu@146.235.196.104
#   ./tunnel.sh -i ~/.ssh/lambda ubuntu@146.235.196.104

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 [-i KEY] user@HOST" >&2
  exit 1
fi

echo "Tunnel: localhost:8000 → remote:8000 (leave this running)"
exec ssh -N -L 8000:127.0.0.1:8000 "$@"
