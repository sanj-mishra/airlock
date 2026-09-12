import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Decision, Verdict } from "@airlock/shared";

/** Human decisions are binary — "escalate" is what got us here. */
export type HumanDecision = "allow" | "block";

const TTL_MS = Number(process.env.ESCALATION_TTL_MS ?? 10 * 60_000);

export interface Escalation {
  id: string;
  verdict: Verdict;
  createdAt: number;
  resolved?: { decision: HumanDecision; at: number };
}

const pending = new Map<string, Escalation>();
type Waiter = (decision: HumanDecision) => void;
const waiters = new Map<string, Waiter[]>();

function secret(): string {
  return process.env.VERDICT_TOKEN_SECRET ?? "";
}

/**
 * A published or missing secret makes every signed link forgeable — including
 * by the agent we're screening, which could approve its own exfiltration.
 */
export function secretIsWeak(): boolean {
  const s = secret();
  return !s || s.startsWith("change-me") || s.length < 32;
}

export function signToken(id: string, decision: string): string {
  return createHmac("sha256", secret()).update(`${id}:${decision}`).digest("hex");
}

export function verifyToken(id: string, decision: string, token: string | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(signToken(id, decision), "utf8");
  const given = Buffer.from(token, "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, esc] of pending) {
    if (esc.createdAt < cutoff) {
      pending.delete(id);
      waiters.delete(id);
    }
  }
}

export interface EscalationLinks {
  id: string;
  allowUrl: string;
  blockUrl: string;
}

export function createEscalation(verdict: Verdict): EscalationLinks {
  sweep();
  const id = randomBytes(9).toString("hex");
  pending.set(id, { id, verdict, createdAt: Date.now() });
  const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
  return {
    id,
    allowUrl: `${base}/v1/verdict/${id}?decision=allow&token=${signToken(id, "allow")}`,
    blockUrl: `${base}/v1/verdict/${id}?decision=block&token=${signToken(id, "block")}`,
  };
}

export function getEscalation(id: string): Escalation | undefined {
  return pending.get(id);
}

export type ResolveOutcome = "ok" | "not_found" | "already_resolved";

export function resolveEscalation(id: string, decision: HumanDecision): ResolveOutcome {
  const esc = pending.get(id);
  if (!esc) return "not_found";
  if (esc.resolved) return "already_resolved";

  esc.resolved = { decision, at: Date.now() };
  const list = waiters.get(id) ?? [];
  waiters.delete(id);
  for (const notify of list) notify(decision);
  return "ok";
}

/**
 * Long-poll until a human decides. "timeout" is the caller's cue to fail
 * closed — an unanswered escalation must never become an allow.
 */
export function waitForEscalation(
  id: string,
  timeoutMs: number,
): Promise<HumanDecision | "timeout"> {
  const esc = pending.get(id);
  if (!esc) return Promise.resolve("timeout");
  if (esc.resolved) return Promise.resolve(esc.resolved.decision);

  return new Promise((resolve) => {
    let done = false;

    const onDecision: Waiter = (decision) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(decision);
    };

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const list = (waiters.get(id) ?? []).filter((w) => w !== onDecision);
      if (list.length) waiters.set(id, list);
      else waiters.delete(id);
      resolve("timeout");
    }, timeoutMs);

    const list = waiters.get(id) ?? [];
    list.push(onDecision);
    waiters.set(id, list);
  });
}

/** Demo/debug visibility — what's outstanding right now. */
export function listEscalations(): Escalation[] {
  sweep();
  return [...pending.values()].sort((a, b) => b.createdAt - a.createdAt);
}
