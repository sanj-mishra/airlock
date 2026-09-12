import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { ScreenRequest, ScreenResponse, Verdict } from "@airlock/shared";
import { catalogSources, loadCatalog } from "./catalog.js";
import { screenEgress } from "./egress.js";
import { screenInjection } from "./injection.js";
import { mailerConfigured, sendEscalation } from "./mailer.js";
import {
  createEscalation,
  getEscalation,
  listEscalations,
  resolveEscalation,
  secretIsWeak,
  verifyToken,
  waitForEscalation,
  type HumanDecision,
} from "./verdict.js";

const port = Number(process.env.PORT ?? 8787);

async function screenOutbound(req: ScreenRequest, started: number): Promise<Verdict> {
  const catalog = await loadCatalog();
  if (req.userId) catalog.userId = req.userId;

  try {
    const result = await screenEgress(req.content, catalog);
    const reason =
      result.decisionHint === "allow"
        ? `Egress clear (${result.signal.score.toFixed(2)}): ${result.rationale}`
        : `Egress ${result.decisionHint} (${result.signal.score.toFixed(2)}, policy=${result.signal.policy}): ${result.rationale}`;

    return {
      decision: result.decisionHint,
      reason,
      signals: { egress: result.signal },
      latencyMs: Date.now() - started,
      sessionId: req.sessionId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: "block",
      reason: `Egress classifier unavailable; failing closed: ${message.slice(0, 200)}`,
      signals: {
        egress: {
          score: 1,
          matchedDocIds: [],
          policy: "screener_error",
        },
      },
      latencyMs: Date.now() - started,
      sessionId: req.sessionId,
    };
  }
}

async function screenInbound(req: ScreenRequest, started: number): Promise<Verdict> {
  try {
    const result = await screenInjection(req.content);
    const reason =
      result.decisionHint === "allow"
        ? `Injection clear (${result.signal.score.toFixed(2)}): ${result.rationale}`
        : `Injection ${result.decisionHint} (${result.signal.score.toFixed(2)}): ${result.rationale}`;

    return {
      decision: result.decisionHint,
      reason,
      signals: { injection: result.signal },
      latencyMs: Date.now() - started,
      sessionId: req.sessionId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      decision: "block",
      reason: `Injection screener unavailable; failing closed: ${message.slice(0, 200)}`,
      signals: { injection: { score: 1, labels: ["screener_error"] } },
      latencyMs: Date.now() - started,
      sessionId: req.sessionId,
    };
  }
}

async function screen(req: ScreenRequest): Promise<Verdict> {
  const started = Date.now();
  if (req.direction === "outbound") return screenOutbound(req, started);
  return screenInbound(req, started);
}

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    ok: true,
    gemma: process.env.GEMMA_BASE_URL ?? "http://127.0.0.1:8000/v1",
    model: process.env.GEMMA_MODEL ?? "google/gemma-2-9b-it",
  }),
);

app.get("/v1/catalog", async (c) => {
  const catalog = await loadCatalog();
  return c.json({ sources: catalogSources(), ...catalog });
});

app.post("/v1/screen", async (c) => {
  const body = (await c.req.json()) as ScreenRequest;
  const verdict = await screen(body);

  if (verdict.decision !== "escalate") {
    return c.json({ verdict } satisfies ScreenResponse);
  }

  // Hold the action, ask a human, and hand the caller something to wait on.
  const links = createEscalation(verdict);
  await sendEscalation(verdict, links, body.content);
  return c.json({ verdict, escalationId: links.id } satisfies ScreenResponse);
});

/** Long-poll until a human answers. Timeout is the caller's cue to fail closed. */
app.get("/v1/verdict/:id/wait", async (c) => {
  const id = c.req.param("id");
  const timeoutMs = Math.min(Number(c.req.query("timeoutMs") ?? 60_000), 120_000);
  const outcome = await waitForEscalation(id, timeoutMs);
  return c.json(
    outcome === "timeout"
      ? { status: "timeout", decision: "block" }
      : { status: "resolved", decision: outcome },
  );
});

/** What's outstanding — handy on the demo terminal. */
app.get("/v1/escalations", (c) =>
  c.json(
    listEscalations().map((e) => ({
      id: e.id,
      reason: e.verdict.reason,
      sessionId: e.verdict.sessionId,
      createdAt: new Date(e.createdAt).toISOString(),
      resolved: e.resolved ?? null,
    })),
  ),
);

/** Gmail Allow/Block link target — verifies the signature, then resumes. */
app.get("/v1/verdict/:id", (c) => {
  const id = c.req.param("id");
  const decision = c.req.query("decision");
  const token = c.req.query("token");

  if (decision !== "allow" && decision !== "block") {
    return c.html(page("Invalid link", "That decision isn't recognised."), 400);
  }

  if (!verifyToken(id, decision, token)) {
    // A forged link is exactly the attack this endpoint exists to stop.
    console.warn(`[verdict] rejected unsigned/invalid token for ${id}`);
    return c.html(page("Invalid link", "This approval link isn't valid."), 403);
  }

  const outcome = resolveEscalation(id, decision as HumanDecision);

  if (outcome === "not_found") {
    return c.html(page("Expired", `Escalation ${id} is no longer pending — it timed out and was blocked.`), 410);
  }
  if (outcome === "already_resolved") {
    const prior = getEscalation(id)?.resolved?.decision ?? "unknown";
    return c.html(page("Already decided", `Escalation ${id} was already <strong>${prior}</strong>.`));
  }

  return c.html(page("Recorded", `Escalation <code>${id}</code> → <strong>${decision}</strong>. The agent has been released.`));
});

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Airlock — ${title}</title></head>
    <body style="font-family:system-ui,-apple-system,sans-serif;padding:2.5rem;max-width:34rem;margin:0 auto;color:#131a22">
      <p style="font:600 11px/1.4 ui-monospace,monospace;letter-spacing:.12em;color:#0b6e77;margin:0 0 6px">AIRLOCK</p>
      <h1 style="font-size:22px;margin:0 0 10px">${title}</h1>
      <p style="color:#47535f;line-height:1.6;margin:0">${body}</p>
    </body></html>`;
}

serve({ fetch: app.fetch, port }, () => {
  console.log(`Airlock gateway listening on http://localhost:${port}`);
  console.log(`Gemma: ${process.env.GEMMA_BASE_URL ?? "http://127.0.0.1:8000/v1"}`);
  console.log(`Mailer: ${mailerConfigured() ? "configured" : "NOT configured — escalations will not be emailed"}`);
  if (secretIsWeak()) {
    console.warn("WARNING: VERDICT_TOKEN_SECRET is weak or unset — approval links are forgeable.");
  }
});
