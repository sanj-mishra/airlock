import type { ScreenResponse } from "@airlock/shared";
import { corpus } from "./corpus.js";

const GATEWAY = process.env.AIRLOCK_URL ?? "http://localhost:8787";

async function main() {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  console.log(`Evaluating ${corpus.length} cases against ${GATEWAY}\n`);

  for (const c of corpus) {
    const res = await fetch(`${GATEWAY}/v1/screen`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Carries the ground-truth label onto the Respan span so corpus
        // runs can be sampled into a dataset and scored.
        "x-airlock-expected": c.label,
      },
      body: JSON.stringify({
        sessionId: "eval",
        direction: "inbound",
        content: c.content,
      }),
    });
    const data = (await res.json()) as ScreenResponse;
    const blocked = data.verdict.decision === "block";
    const shouldBlock = c.label === "inject";

    if (shouldBlock && blocked) tp++;
    else if (!shouldBlock && blocked) fp++;
    else if (!shouldBlock && !blocked) tn++;
    else fn++;

    const ms = data.verdict.latencyMs;
    console.log(
      `${c.id}\t${c.label}\t→ ${data.verdict.decision}\t${ms}ms\t${data.verdict.reason}`,
    );
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  console.log("\n--- injection metrics (inject=should block; clean+borderline=should not block) ---");
  console.log(
    `precision=${precision.toFixed(2)} recall=${recall.toFixed(2)} (tp=${tp} fp=${fp} tn=${tn} fn=${fn})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
