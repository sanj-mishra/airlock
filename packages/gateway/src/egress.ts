import type { CatalogLookup, Decision, EgressSignal, Sensitivity } from "@airlock/shared";
import { gemmaChat } from "./gemma.js";

const SENSITIVE: Sensitivity[] = ["confidential", "restricted"];

const INSTRUCTIONS = `You are Airlock's outbound egress classifier for AI agents.
Given (1) an outbound payload the agent is about to send/execute and (2) an org
sensitivity catalog of documents + the requester's Okta groups, decide whether
the payload appears to leak catalog material.

Match semantically — e.g. "what we discussed about the acquisition target" can
match a confidential acquisition doc even without the exact title.

Respond with ONLY a single JSON object (no markdown fences, no prose):
{"score":0.0,"matchedDocIds":["id"],"rationale":"one short sentence"}

score is 0.0–1.0 likelihood the outbound content discloses catalog material.
matchedDocIds: subset of catalog document ids that appear referenced or disclosed.
Empty matchedDocIds if score is near 0.`;

export interface EgressScreenResult {
  signal: EgressSignal;
  rationale: string;
  decisionHint: Decision;
}

function truncate(content: string, max = Number(process.env.EGRESS_MAX_CHARS ?? 2500)): string {
  if (content.length <= max) return content;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${content.slice(0, head)}\n\n…[truncated]…\n\n${content.slice(-tail)}`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) return JSON.parse(fence[1].trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`Could not parse egress JSON: ${trimmed.slice(0, 200)}`);
  }
}

function userInOwnerGroup(userGroups: string[], ownerGroups: string[]): boolean {
  if (ownerGroups.length === 0) return true; // no ACL → don't deny on group miss
  const set = new Set(userGroups.map((g) => g.toLowerCase()));
  return ownerGroups.some((g) => set.has(g.toLowerCase()));
}

/**
 * Deterministic ACL after Gemma (or heuristic) picks candidate docs.
 * Policy: confidential/restricted content may only leave if the user is in an owner group.
 */
function applyAcl(
  catalog: CatalogLookup,
  matchedDocIds: string[],
  score: number,
): { decision: Decision; policy: string; matched: string[] } {
  const docs = matchedDocIds
    .map((id) => catalog.documents.find((d) => d.id === id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));

  const sensitiveHits = docs.filter((d) => SENSITIVE.includes(d.sensitivity));
  const denied = sensitiveHits.filter(
    (d) => !userInOwnerGroup(catalog.oktaGroups, d.ownerGroups),
  );

  const blockAt = Number(process.env.EGRESS_BLOCK_THRESHOLD ?? 0.7);
  const escalateAt = Number(process.env.EGRESS_ESCALATE_THRESHOLD ?? 0.4);

  if (denied.length > 0 && score >= blockAt) {
    return {
      decision: "block",
      policy: "confidential_requires_owner_group",
      matched: denied.map((d) => d.id),
    };
  }

  if (denied.length > 0 && score >= escalateAt) {
    return {
      decision: "escalate",
      policy: "confidential_requires_owner_group",
      matched: denied.map((d) => d.id),
    };
  }

  if (sensitiveHits.length > 0 && score >= escalateAt) {
    // User is in an owner group, but still shipping sensitive material outbound.
    return {
      decision: "escalate",
      policy: "sensitive_outbound_review",
      matched: sensitiveHits.map((d) => d.id),
    };
  }

  // High model score but no resolvable catalog ids — human review.
  if (score >= escalateAt && docs.length === 0) {
    return {
      decision: "escalate",
      policy: "catalog_match_uncertain",
      matched: [],
    };
  }

  // Internal/public matches (or no sensitive hit) → allow.
  return {
    decision: "allow",
    policy: docs.length > 0 ? "catalog_match_permitted" : "no_sensitive_egress",
    matched: docs.map((d) => d.id),
  };
}

/** Cheap prefilter so we still demo if Gemma is down. */
function heuristicMatches(content: string, catalog: CatalogLookup): string[] {
  const lower = content.toLowerCase();
  return catalog.documents
    .filter((d) => {
      const tokens = [d.title, d.excerpt ?? ""]
        .join(" ")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 5);
      return tokens.some((t) => lower.includes(t));
    })
    .map((d) => d.id);
}

export async function screenEgress(
  content: string,
  catalog: CatalogLookup,
): Promise<EgressScreenResult> {
  const catalogForModel = {
    userId: catalog.userId,
    oktaGroups: catalog.oktaGroups,
    documents: catalog.documents.map((d) => ({
      id: d.id,
      title: d.title,
      sensitivity: d.sensitivity,
      ownerGroups: d.ownerGroups,
      excerpt: d.excerpt ?? "",
    })),
  };

  let score = 0;
  let matchedDocIds: string[] = [];
  let rationale = "no rationale";
  try {
    const { content: raw } = await gemmaChat(
      [
        {
          role: "user",
          content: `${INSTRUCTIONS}

Requester groups: ${JSON.stringify(catalog.oktaGroups)}

Catalog:
${JSON.stringify(catalogForModel.documents)}

Outbound payload:
---
${truncate(content)}
---`,
        },
      ],
      { maxTokens: 220, temperature: 0 },
    );
    const parsed = extractJson(raw) as {
      score?: number;
      matchedDocIds?: unknown;
      rationale?: string;
    };
    score = Math.min(1, Math.max(0, Number(parsed.score ?? 0)));
    matchedDocIds = Array.isArray(parsed.matchedDocIds)
      ? parsed.matchedDocIds.map(String).filter((id) => catalog.documents.some((d) => d.id === id))
      : [];
    rationale = String(parsed.rationale ?? "no rationale").slice(0, 280);
  } catch (err) {
    // Fall back to heuristic match so ACL still works for the demo if Gemma blips.
    matchedDocIds = heuristicMatches(content, catalog);
    score = matchedDocIds.length > 0 ? 0.85 : 0;
    rationale = `Gemma unavailable (${err instanceof Error ? err.message : String(err)}); used title/excerpt heuristic`;
  }

  if (matchedDocIds.length === 0 && score >= 0.4) {
    matchedDocIds = heuristicMatches(content, catalog);
  }

  const acl = applyAcl(catalog, matchedDocIds, score);

  return {
    signal: {
      score,
      matchedDocIds: acl.matched.length > 0 ? acl.matched : matchedDocIds,
      policy: acl.policy,
    },
    rationale,
    decisionHint: acl.decision,
  };
}
