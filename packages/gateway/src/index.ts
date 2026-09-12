import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { ScreenRequest, ScreenResponse, Verdict } from "@airlock/shared";
import { catalogSources, loadCatalog } from "./catalog.js";

const port = Number(process.env.PORT ?? 8787);

/** Stub adjudicator — replace with real screeners + Gemma. */
function stubVerdict(req: ScreenRequest): Verdict {
  const started = Date.now();
  const lower = req.content.toLowerCase();
  const looksLikeInject =
    lower.includes("ignore previous") ||
    lower.includes("system prompt") ||
    lower.includes("exfiltrate");

  if (req.direction === "inbound" && looksLikeInject) {
    return {
      decision: "block",
      reason: "Stub: inbound content matched injection heuristic",
      signals: { injection: { score: 0.95, labels: ["instruction_override"] } },
      latencyMs: Date.now() - started,
      sessionId: req.sessionId,
    };
  }

  if (req.direction === "outbound" && lower.includes("acquisition")) {
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
    reason: "Stub: no signals above threshold",
    signals: {},
    latencyMs: Date.now() - started,
    sessionId: req.sessionId,
  };
}

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/v1/catalog", async (c) => {
  const catalog = await loadCatalog();
  return c.json({ sources: catalogSources(), ...catalog });
});

app.post("/v1/screen", async (c) => {
  const body = (await c.req.json()) as ScreenRequest;
  const response: ScreenResponse = { verdict: stubVerdict(body) };
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

// @hono/node-server may not be installed if we only listed hono —
// use hono's serve via @hono/node-server. Add dependency.
serve({ fetch: app.fetch, port }, () => {
  console.log(`Airlock gateway listening on http://localhost:${port}`);
});
