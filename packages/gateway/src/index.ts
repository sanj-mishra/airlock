import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { ScreenRequest, ScreenResponse, Verdict } from "@airlock/shared";
import { catalogSources, loadCatalog } from "./catalog.js";
import { screenInjection } from "./injection.js";

const port = Number(process.env.PORT ?? 8787);

/** Outbound stub until egress classifier lands. */
function stubOutbound(req: ScreenRequest, started: number): Verdict {
  const lower = req.content.toLowerCase();
  if (lower.includes("acquisition")) {
    return {
      decision: "escalate",
      reason: "Stub: outbound content may reference confidential material",
      signals: {
        egress: {
          score: 0.7,
          matchedDocIds: ["gdrive-acq-001"],
          policy: "confidential_requires_owner_group",
        },
      },
      latencyMs: Date.now() - started,
      sessionId: req.sessionId,
    };
  }
  return {
    decision: "allow",
    reason: "Stub: no egress signals above threshold",
    signals: {},
    latencyMs: Date.now() - started,
    sessionId: req.sessionId,
  };
}

async function screen(req: ScreenRequest): Promise<Verdict> {
  const started = Date.now();

  if (req.direction === "outbound") {
    return stubOutbound(req, started);
  }

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
    // Fail closed on screener errors for inbound — don't let untrusted content through.
    return {
      decision: "block",
      reason: `Injection screener unavailable; failing closed: ${message.slice(0, 200)}`,
      signals: { injection: { score: 1, labels: ["screener_error"] } },
      latencyMs: Date.now() - started,
      sessionId: req.sessionId,
    };
  }
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
  const response: ScreenResponse = { verdict: await screen(body) };
  return c.json(response);
});

/** Gmail Allow/Block link target — records human verdict (stub). */
app.get("/v1/verdict/:id", (c) => {
  const id = c.req.param("id");
  const decision = c.req.query("decision") ?? "unknown";
  return c.html(
    `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
      <h1>Recorded</h1>
      <p>Escalation <code>${id}</code> → <strong>${decision}</strong></p>
      <p>Wire this to the adjudicator + Respan eval case next.</p>
    </body></html>`,
  );
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`Airlock gateway listening on http://localhost:${port}`);
  console.log(`Gemma: ${process.env.GEMMA_BASE_URL ?? "http://127.0.0.1:8000/v1"}`);
});
