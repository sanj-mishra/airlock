# Airlock — 5-hour pair plan

Security control plane for AI agents: screen inbound context for prompt injection and outbound payloads for sensitive data, using a self-hosted open-weight model on Lambda.

## Locked decisions

- **Team:** 2 people · **5 hours** · keys start at phase 0
- **Stack:** TypeScript/Node (gateway, hooks, email, Nango, Respan)
- **Intercept:** Cursor hooks → Airlock HTTP
- **HITL:** Gmail with signed Allow/Block links (nodemailer SMTP or Resend)
- **Scope tonight:** injection screener, egress classifier, Drive+Okta catalog, adjudicator (allow/block/escalate), Respan traces+evals, Cursor hook path. No trajectory scorer, no redact, no extra Nango connectors, no custom demo UI beyond Respan/Gmail/logs.

**Pitch:** Airlock sits on Cursor’s hook surface so untrusted tool/file content is screened before it enters context, and exfil tool calls can be denied. The inspector runs on self-hosted Gemma — it can’t be the cloud API you’re trying to inspect.

## Architecture

```
Cursor Agent → Cursor Hooks → Airlock Gateway
                                 ├─ Injection Screener ─┐
                                 ├─ Egress Classifier ──┼→ Adjudicator → allow | block | escalate
                                 └─ Sensitivity Catalog ← Nango (Drive + Okta)
                                                          ├─ Gmail HITL (Allow/Block links)
                                                          └─ Respan (traces + evals)
```

## Gmail HITL

1. Escalate → email with reason + payload excerpt.
2. Body has signed links: `GET /v1/verdict/:id?decision=allow|block&token=...`
3. Click → one-line “Recorded” page; gateway resumes and writes a Respan eval case.

Prefer Gmail SMTP + app password (`nodemailer`); Resend if SMTP stalls. No IMAP reply parsing.

## Frozen contracts

Shared types live in [`packages/shared/src/types.ts`](packages/shared/src/types.ts).

**`CatalogLookup`** — what the egress classifier queries.

**`Verdict`** — what the adjudicator emits (`allow` | `block` | `escalate`).

Agree in hour 0, freeze, stub both sides.

## Work split

### Phase 0 — 0:00–0:30 (both)

1. Lambda GPU + HF Gemma license/token
2. Nango + Google Drive + Okta
3. Respan API key
4. Gmail SMTP or Resend — one test mail with a dummy Allow link

### Tooling constraint (updated mid-build)

Alex has Gemma **and** Cursor; Sanjana is on Claude Code. Cursor is both the
intercept surface and the demo surface, so the hook path and demo beats 2–3
moved to Alex. The adjudicator, Respan spans, and the eval corpus moved to
Sanjana — all gateway/HTTP work needing neither Cursor nor a local GPU. The
frozen contracts in `packages/shared` are what make this swap cheap.

### Person A — Alex · model + intercept

| Window | Work |
| --- | --- |
| 0:30–1:30 | Gemma on Lambda via vLLM OpenAI API. **Done** — see `scripts/lambda/`. |
| 1:30–2:00 | Verify Cursor hook event shapes against `extractContent()`; confirm a block reaches the IDE. |
| 2:00–3:00 | Injection screener on Gemma. |
| 3:00–3:45 | Egress classifier on `CatalogLookup`; run screeners in parallel. |
| 3:45–4:15 | Demo path: poisoned doc + egress deny via `beforeShellExecution`. |
| 4:15–4:30 | p50/p95 latency for demo. |

### Person B — Sanjana · gateway, decisions, evidence

| Window | Work |
| --- | --- |
| 0:30–1:30 | Nango Drive → `CatalogLookup`. **Done** — Drive live, Okta served from fixture. |
| 1:30–2:30 | Gateway: signed `GET /v1/verdict/:id` — HMAC, pending store, resume. |
| 2:30–3:00 | Adjudicator: combine screener signals → `Verdict`; Respan spans. |
| 3:00–3:30 | Eval corpus → ~20 inject / ~20 clean / ~10 borderline. |
| 3:30–4:15 | Email escalate → Allow/Block → Respan eval case. |
| 4:15–4:30 | Run eval; capture precision/recall for the demo. |

### Demo-day logistics

Cursor hooks call `localhost:8787`, so **the gateway runs on Alex's machine**.
He needs `NANGO_SECRET_KEY`, `NANGO_DRIVE_CONNECTION_ID`, and the email
credentials in his own `.env` — gitignored, so share them out of band.

Beat 4 is a two-hander: Alex triggers the borderline action in Cursor, the
escalation email lands, Sanjana clicks Allow and brings up Respan.

### Freeze — 4:30–5:00

Stop coding. Rehearse the 3-minute demo three times. Memorize precision and latency.

## Demo (3 min)

1. Frame: inspector can’t be the inspected cloud API.
2. Injection: poisoned file/MCP → block.
3. Egress: confidential Drive doc + Okta group miss → block.
4. Borderline → Gmail Allow/Block click → Respan eval case.
5. Respan precision/recall + inline latency.

## Risks

1. Lambda/Gemma first; fallback open-weight.
2. Nango: two connectors max; fixture backup.
3. Screeners in parallel; high-confidence inject blocks, else escalate.
4. Email to your own inbox with tab open for the live click.

**Never cut:** Lambda model, injection screener, email HITL, Respan eval numbers, Cursor hooks.
