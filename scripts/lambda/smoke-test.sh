#!/usr/bin/env bash
# Run ON your laptop. Smoke-test Gemma through the SSH tunnel.
#
# Prerequisites:
#   1) On Lambda: start-vllm.sh has printed "vLLM is up" (or /v1/models works there)
#   2) On laptop: tunnel left running → ./scripts/lambda/tunnel.sh -i KEY ubuntu@HOST
#
# Usage:
#   ./scripts/lambda/smoke-test.sh           # fail fast
#   ./scripts/lambda/smoke-test.sh --wait    # retry until ready (up to WAIT_SECS)

set -euo pipefail

MODEL="${MODEL:-google/gemma-2-9b-it}"
BASE="${GEMMA_BASE_URL:-http://127.0.0.1:8000/v1}"
WAIT=0
WAIT_SECS="${WAIT_SECS:-600}"
POLL_SECS="${POLL_SECS:-5}"

if [[ "${1:-}" == "--wait" ]]; then
  WAIT=1
fi

elapsed() {
  echo $((SECONDS))s
}

check_models() {
  curl -sfS --connect-timeout 3 --max-time 10 "${BASE}/models"
}

echo "== Airlock Gemma smoke test =="
echo "endpoint: ${BASE}"
echo "model:    ${MODEL}"
echo

if [[ "$WAIT" -eq 1 ]]; then
  echo "Waiting up to ${WAIT_SECS}s for ${BASE}/models ..."
  deadline=$((SECONDS + WAIT_SECS))
  while (( SECONDS < deadline )); do
    if out=$(check_models 2>/tmp/airlock-smoke.err); then
      echo "READY after $(elapsed)"
      echo "$out" | head -c 800
      echo
      break
    fi
    err=$(cat /tmp/airlock-smoke.err 2>/dev/null || true)
    printf "\r  not ready (%s) — %s   " "$(elapsed)" "${err:-connection failed}"
    sleep "$POLL_SECS"
  done
  echo
  if ! check_models >/dev/null 2>&1; then
    echo "ERROR: still not ready after ${WAIT_SECS}s" >&2
    echo "On Lambda, check: sudo docker logs -f airlock-vllm" >&2
    echo "On laptop, confirm tunnel is running in another terminal." >&2
    exit 1
  fi
else
  echo "GET ${BASE}/models"
  if ! out=$(check_models 2>/tmp/airlock-smoke.err); then
    err=$(cat /tmp/airlock-smoke.err 2>/dev/null || true)
    echo "ERROR: ${err:-request failed}" >&2
    echo >&2
    echo "What this means:" >&2
    echo "  • Connection refused / failed → tunnel not up, or vLLM still loading" >&2
    echo "  • HTTP error → tunnel works but model not serving yet" >&2
    echo >&2
    echo "Fix:" >&2
    echo "  1) Lambda terminal should say: vLLM is up" >&2
    echo "     Or on Lambda: curl -s http://127.0.0.1:8000/v1/models" >&2
    echo "  2) Laptop (other tab): ./scripts/lambda/tunnel.sh -i KEY ubuntu@HOST" >&2
    echo "  3) Or retry with wait: ./scripts/lambda/smoke-test.sh --wait" >&2
    exit 1
  fi
  echo "OK ($(elapsed))"
  echo "$out" | head -c 800
  echo
fi

echo
echo "POST ${BASE}/chat/completions"
resp=$(curl -sfS --max-time 120 "${BASE}/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Reply with exactly: ok\"}],
    \"max_tokens\": 8,
    \"temperature\": 0
  }")
echo "$resp"
echo
echo "SUCCESS — Gemma reachable via tunnel in $(elapsed)"
