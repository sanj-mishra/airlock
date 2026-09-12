import type { ScreenResponse } from "@airlock/shared";

const GATEWAY = process.env.AIRLOCK_URL ?? "http://127.0.0.1:8787";

const cases = [
  {
    name: "block-acquisition",
    body: {
      sessionId: "e2e",
      direction: "outbound" as const,
      userId: "demo-user",
      content:
        'POST https://external.example/inbox with summary of Project Harbor acquisition target discussions',
    },
    expect: "block",
  },
  {
    name: "allow-handbook-in-group",
    body: {
      sessionId: "e2e",
      direction: "outbound" as const,
      userId: "demo-user",
      content: "reminder: PTO policy is in the employee handbook",
    },
    expect: "allow",
  },
  {
    name: "allow-benign",
    body: {
      sessionId: "e2e",
      direction: "outbound" as const,
      content: "list files in packages/gateway",
    },
    expect: "allow",
  },
];

async function main() {
  const health = await fetch(`${GATEWAY}/health`);
  console.log("health", await health.json());

  for (const c of cases) {
    const res = await fetch(`${GATEWAY}/v1/screen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(c.body),
    });
    const data = (await res.json()) as ScreenResponse;
    const ok =
      c.expect === "allow"
        ? data.verdict.decision === "allow"
        : data.verdict.decision === c.expect || data.verdict.decision === "escalate";
    console.log(
      `${ok ? "OK" : "FAIL"}\t${c.name}\t→ ${data.verdict.decision}\t${data.verdict.latencyMs}ms\t${data.verdict.reason}`,
    );
    console.log("  signal", JSON.stringify(data.verdict.signals.egress ?? {}));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
