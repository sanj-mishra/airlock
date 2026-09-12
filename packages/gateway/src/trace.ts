import { Respan, withTask } from "@respan/respan";
import { trace } from "@opentelemetry/api";
import type { Verdict } from "@airlock/shared";

let enabled = false;

export function tracingConfigured(): boolean {
  return Boolean(process.env.RESPAN_API_KEY);
}

export function tracingEnabled(): boolean {
  return enabled;
}

export async function initTracing(): Promise<boolean> {
  if (!tracingConfigured()) return false;

  try {
    const respan = new Respan({
      apiKey: process.env.RESPAN_API_KEY,
      appName: process.env.RESPAN_APP_NAME ?? "airlock",
      /**
       * Screened content is untrusted and frequently confidential — it is the
       * whole point of the product. Keep it out of the trace payload unless
       * explicitly opted in, so "what we inspect doesn't leave your infra"
       * stays true of the observability layer too.
       */
      traceContent: process.env.RESPAN_TRACE_CONTENT === "1",
      // The demo shows this terminal — default to quiet, not debug.
      logLevel: (process.env.RESPAN_LOG_LEVEL as "debug" | "info" | "warn" | "error") ?? "warn",
      silenceInitializationMessage: true,
    });
    await respan.initialize();
    enabled = true;
  } catch (err) {
    console.warn("[trace] Respan init failed; continuing untraced:", err);
    enabled = false;
  }
  return enabled;
}

type Attrs = Record<string, string | number | boolean | undefined | null>;

function clean(attrs: Attrs): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** Attach attributes to the span in scope. Never throws — tracing must not decide verdicts. */
export function annotate(attrs: Attrs): void {
  if (!enabled) return;
  try {
    trace.getActiveSpan()?.setAttributes(clean(attrs));
  } catch {
    /* ignore */
  }
}

/** Run fn inside a Respan task span. Passthrough when tracing is off. */
export async function traced<T>(
  name: string,
  attrs: Attrs,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) return fn();
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(clean(attrs))) props[k] = String(v);
  try {
    return await withTask({ name, associationProperties: props }, fn);
  } catch (err) {
    // A tracing failure must not swallow or alter the screening result.
    if (err instanceof Error && err.message.includes("respan")) {
      console.warn("[trace] span failed; running untraced:", err.message);
      return fn();
    }
    throw err;
  }
}

/** The attribute set every screening decision reports, for eval + latency rollups. */
export function verdictAttributes(verdict: Verdict): Attrs {
  return {
    "airlock.decision": verdict.decision,
    "airlock.reason": verdict.reason.slice(0, 300),
    "airlock.latency_ms": verdict.latencyMs,
    "airlock.session_id": verdict.sessionId,
    "airlock.injection.score": verdict.signals.injection?.score,
    "airlock.injection.labels": verdict.signals.injection?.labels.join(",") || undefined,
    "airlock.egress.score": verdict.signals.egress?.score,
    "airlock.egress.policy": verdict.signals.egress?.policy,
    "airlock.egress.matched_docs":
      verdict.signals.egress?.matchedDocIds.join(",") || undefined,
  };
}
