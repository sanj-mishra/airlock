# Airlock

A security control plane for AI agents. Screens what enters an agent’s context for prompt injection, and what leaves for sensitive data — both checks on a self-hosted open-weight model.

See [PLAN.md](./PLAN.md) for the hackathon build plan and work split.

## Repo layout

```
packages/shared/    Shared CatalogLookup + Verdict types
packages/gateway/   Airlock HTTP service (screen + email verdict)
packages/hooks/     Cursor hook scripts → gateway
packages/eval/      Injection eval corpus + runner
fixtures/           Seed sensitivity catalog
demo/               Poisoned doc for the injection demo
```

## Quick start

```bash
npm install
npm run build
npm run gateway   # http://localhost:8787
```

Copy `.env.example` to `.env` and fill in keys as you get them.

## Integration contracts

Frozen in `packages/shared`:

- **CatalogLookup** — org sensitivity + identity catalog for the egress classifier
- **Verdict** — adjudicator output: `allow` | `block` | `escalate`
