#!/usr/bin/env node
/**
 * Cursor hook entry: read JSON event from stdin, POST to Airlock gateway, write JSON decision to stdout.
 * Wire from .cursor/hooks.json once screeners are live.
 */
import type { ScreenRequest, ScreenResponse } from "@airlock/shared";

const GATEWAY = process.env.AIRLOCK_URL ?? "http://localhost:8787";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractContent(event: Record<string, unknown>): {
  direction: "inbound" | "outbound";
  content: string;
} {
  // Best-effort mapping across hook event shapes; refine per event type.
  if (typeof event.content === "string") {
    return { direction: "inbound", content: event.content };
  }
  if (typeof event.tool_output === "string") {
    return { direction: "inbound", content: event.tool_output };
  }
  if (typeof event.prompt === "string") {
    return { direction: "inbound", content: event.prompt };
  }
  if (typeof event.command === "string") {
    return { direction: "outbound", content: event.command };
  }
  return { direction: "inbound", content: JSON.stringify(event) };
}

async function main() {
  const raw = await readStdin();
  let event: Record<string, unknown> = {};
  try {
    event = JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    event = { raw };
  }

  const { direction, content } = extractContent(event);
  const body: ScreenRequest = {
    sessionId: String(event.session_id ?? event.sessionId ?? "local"),
    direction,
    content,
    source: {
      kind: String(event.hook_event_name ?? event.event ?? "unknown"),
      name: typeof event.tool_name === "string" ? event.tool_name : undefined,
    },
  };

  try {
    const res = await fetch(`${GATEWAY}/v1/screen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as ScreenResponse;
    const decision = data.verdict.decision;

    if (decision === "block") {
      process.stdout.write(
        JSON.stringify({
          continue: false,
          permission: "deny",
          userMessage: data.verdict.reason,
        }),
      );
      return;
    }

    // escalate / allow: let the agent proceed; escalate is handled async via email
    process.stdout.write(JSON.stringify({ continue: true, permission: "allow" }));
  } catch (err) {
    // Fail closed: an unreachable gateway means content is unscreened, so deny
    // rather than let it through. Set AIRLOCK_FAIL_OPEN=1 to bypass during setup.
    console.error("[airlock-hook]", err);
    if (process.env.AIRLOCK_FAIL_OPEN === "1") {
      process.stdout.write(JSON.stringify({ continue: true, permission: "allow" }));
      return;
    }
    process.stdout.write(
      JSON.stringify({
        continue: false,
        permission: "deny",
        userMessage:
          "Airlock gateway unreachable — denying unscreened content. Start the gateway, or set AIRLOCK_FAIL_OPEN=1 during setup.",
      }),
    );
  }
}

main();
