#!/usr/bin/env bash
# Run ON the Lambda instance. Starts Gemma via vLLM (OpenAI-compatible on :8000).
# Usage:
#   export HF_TOKEN=hf_...
#   ./start-vllm.sh
# Optional:
#   MODEL=google/gemma-2-2b-it ./start-vllm.sh          # if 9B OOM on KV cache
#   MAX_MODEL_LEN=1024 GPU_MEM_UTIL=0.95 ./start-vllm.sh

set -euo pipefail

MODEL="${MODEL:-google/gemma-2-9b-it}"
PORT="${PORT:-8000}"
HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
CONTAINER_NAME="${CONTAINER_NAME:-airlock-vllm}"
# Screening payloads don't need long context; lower len = less KV VRAM.
MAX_MODEL_LEN="${MAX_MODEL_LEN:-2048}"
GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.95}"

if [[ -z "${HF_TOKEN:-}" ]]; then
  echo "Set HF_TOKEN to a Hugging Face token with access to ${MODEL}" >&2
  echo "  export HF_TOKEN=hf_..." >&2
  exit 1
fi

mkdir -p "$HF_HOME"

if sudo docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "Removing existing container ${CONTAINER_NAME}..."
  sudo docker rm -f "$CONTAINER_NAME" >/dev/null
fi

echo "Starting ${MODEL} on port ${PORT}..."
echo "  max_model_len=${MAX_MODEL_LEN}  gpu_memory_utilization=${GPU_MEM_UTIL}  enforce_eager=on"
# enforce-eager skips CUDA graphs (saves VRAM). Current vLLM wants positional model.
sudo docker run -d \
  --name "$CONTAINER_NAME" \
  --gpus all \
  --ipc=host \
  -p "${PORT}:8000" \
  -v "${HF_HOME}:/root/.cache/huggingface" \
  -e "HUGGING_FACE_HUB_TOKEN=${HF_TOKEN}" \
  vllm/vllm-openai:latest \
  "${MODEL}" \
  --host 0.0.0.0 \
  --port 8000 \
  --max-model-len "${MAX_MODEL_LEN}" \
  --gpu-memory-utilization "${GPU_MEM_UTIL}" \
  --enforce-eager

echo "Container started. Ready when /v1/models responds:"
echo "  curl -s http://127.0.0.1:${PORT}/v1/models"
echo

for i in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
    echo
    echo "vLLM is up: http://127.0.0.1:${PORT}/v1"
    curl -s "http://127.0.0.1:${PORT}/v1/models"
    echo
    exit 0
  fi
  if (( i % 6 == 1 )); then
    echo "--- still loading ($((i * 5))s) — last logs ---"
    sudo docker logs --tail 20 "$CONTAINER_NAME" 2>&1 || true
    echo "----------------------------------------------"
  fi
  if ! sudo docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    echo "Container exited. Full logs:" >&2
    sudo docker logs "$CONTAINER_NAME" >&2 || true
    echo >&2
    echo "If you saw 'No available memory for the cache blocks':" >&2
    echo "  MAX_MODEL_LEN=1024 ./start-vllm.sh" >&2
    echo "  or MODEL=google/gemma-2-2b-it ./start-vllm.sh" >&2
    exit 1
  fi
  sleep 5
done

echo "Timed out waiting for vLLM. Check logs:" >&2
echo "  sudo docker logs -f ${CONTAINER_NAME}" >&2
exit 1
