#!/usr/bin/env node
/**
 * Cursor hook entry: read JSON event from stdin, POST to Airlock gateway, write JSON decision to stdout.
 */
import { readFileSync } from "node:fs";
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
  const hook = String(event.hook_event_name ?? event.event ?? "");

  if (typeof event.command === "string") {
    return { direction: "outbound", content: event.command };
  }
  if (typeof event.content === "string" && event.content.length > 0) {
    return { direction: "inbound", content: event.content };
  }
  if (typeof event.tool_output === "string" && event.tool_output.length > 0) {
    return { direction: "inbound", content: event.tool_output };
  }
  if (typeof event.prompt === "string" && event.prompt.length > 0) {
    return { direction: "inbound", content: event.prompt };
  }

  // beforeReadFile / Read: load from disk if payload only has a path
  const filePath =
    (typeof event.file_path === "string" && event.file_path) ||
    (typeof event.path === "string" && event.path) ||
    (typeof event.filePath === "string" && event.filePath) ||
    "";
  if (filePath) {
    try {
      return { direction: "inbound", content: readFileSync(filePath, "utf8") };
    } catch (err) {
      console.error("[airlock-hook] could not read file_path", filePath, err);
    }
  }

  // preToolUse(Read): tool input may nest the path
  const input = event.tool_input ?? event.input;
  if (input && typeof input === "object") {
    const tip = input as Record<string, unknown>;
    const p = tip.path ?? tip.file_path ?? tip.target_file;
    if (typeof p === "string") {
      try {
        return { direction: "inbound", content: readFileSync(p, "utf8") };
      } catch (err) {
        console.error("[airlock-hook] could not read tool path", p, err);
      }
    }
  }

  console.error(
    "[airlock-hook] fallback stringify; hook=",
    hook,
    "keys=",
    Object.keys(event),
  );
  return { direction: "inbound", content: JSON.stringify(event) };
}

function deny(reason: string): never {
  process.stdout.write(
    JSON.stringify({
      permission: "deny",
      continue: false,
      user_message: reason,
      userMessage: reason,
      agent_message: reason,
      agentMessage: reason,
    }),
  );
  // Exit 2 = hard block per Cursor hooks docs
  process.exit(2);
}

function allow(): never {
  process.stdout.write(JSON.stringify({ permission: "allow", continue: true }));
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  let event: Record<string, unknown> = {};
  try {
    event = JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    event = { raw };
  }

  const hook = String(event.hook_event_name ?? event.event ?? "unknown");
  const { direction, content } = extractContent(event);
  console.error(
    `[airlock-hook] ${hook} dir=${direction} bytes=${content.length}`,
  );

  const body: ScreenRequest = {
    sessionId: String(event.session_id ?? event.sessionId ?? "local"),
    direction,
    content,
    source: {
      kind: hook,
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
    console.error(`[airlock-hook] decision=${decision} ${data.verdict.reason.slice(0, 120)}`);

    if (decision === "block") {
      deny(data.verdict.reason);
    }

    if (decision === "escalate" && data.escalationId) {
      const timeoutMs = Number(process.env.AIRLOCK_ESCALATION_TIMEOUT_MS ?? 60_000);
      console.error(`[airlock-hook] escalated ${data.escalationId} — awaiting approval`);

      const waitRes = await fetch(
        `${GATEWAY}/v1/verdict/${data.escalationId}/wait?timeoutMs=${timeoutMs}`,
      );
      const outcome = (await waitRes.json()) as {
        status: "resolved" | "timeout";
        decision: "allow" | "block";
      };

      if (outcome.status === "resolved" && outcome.decision === "allow") {
        allow();
      }

      deny(
        outcome.status === "timeout"
          ? "Airlock: approval timed out — blocked."
          : "Airlock: blocked by human reviewer.",
      );
    }

    allow();
  } catch (err) {
    console.error("[airlock-hook]", err);
    if (process.env.AIRLOCK_FAIL_OPEN === "1") {
      allow();
    }
    deny(
      "Airlock gateway unreachable — denying unscreened content. Start the gateway, or set AIRLOCK_FAIL_OPEN=1 during setup.",
    );
  }
}

main();
