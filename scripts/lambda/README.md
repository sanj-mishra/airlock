# Lambda + Gemma bring-up

Lambda’s hosted Inference API is winding down — we run **vLLM on an On-Demand GPU** instead.

## Important: power off vs terminate

- **Terminate** usually **wipes the instance disk**. Scripts on the box are gone; IP changes.
- Keep these scripts in the git repo and re-copy after launch.
- First model download is slow; later starts reuse `~/.cache/huggingface` **only if that disk still exists**.

## One-time on a fresh instance

```bash
# from your laptop (adjust key + IP)
scp -i ~/.ssh/lambda scripts/lambda/start-vllm.sh ubuntu@INSTANCE_IP:~/
ssh -i ~/.ssh/lambda ubuntu@INSTANCE_IP
```

On the instance:

```bash
chmod +x ~/start-vllm.sh
export HF_TOKEN=hf_...   # Gemma license accepted on Hugging Face
./start-vllm.sh
```

Optional smaller/faster model if 9B is tight on VRAM:

```bash
MODEL=google/gemma-2-2b-it ./start-vllm.sh
```

## Every time you come back (disk still there)

```bash
# on instance
export HF_TOKEN=hf_...
./start-vllm.sh

# on laptop (second terminal) — do not open port 8000 on the firewall
./scripts/lambda/tunnel.sh -i ~/.ssh/lambda ubuntu@INSTANCE_IP

# on laptop
./scripts/lambda/smoke-test.sh
```

Then in Airlock `.env`:

```bash
GEMMA_BASE_URL=http://127.0.0.1:8000/v1
GEMMA_MODEL=google/gemma-2-9b-it
```

## Demo tip

Leave the tunnel terminal open while the gateway runs. Terminate the GPU when you’re done so you don’t burn credits overnight.
