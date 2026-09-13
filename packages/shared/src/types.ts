/** Sensitivity levels used by the org catalog and egress classifier. */
export type Sensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export type DocumentSource = "gdrive";

export interface CatalogDocument {
  id: string;
  source: DocumentSource;
  title: string;
  sensitivity: Sensitivity;
  /** Okta (or equivalent) groups that own / may access this document. */
  ownerGroups: string[];
  excerpt?: string;
}

/** What the egress classifier receives from the sensitivity + identity catalog. */
export interface CatalogLookup {
  userId: string;
  oktaGroups: string[];
  documents: CatalogDocument[];
}

export type Decision = "allow" | "block" | "escalate";

export interface InjectionSignal {
  score: number;
  labels: string[];
}

export interface EgressSignal {
  score: number;
  matchedDocIds: string[];
  policy: string;
}

/** What the adjudicator emits after combining screener signals. */
export interface Verdict {
  decision: Decision;
  reason: string;
  signals: {
    injection?: InjectionSignal;
    egress?: EgressSignal;
  };
  latencyMs: number;
  sessionId: string;
}

/** Request body for POST /v1/screen */
export interface ScreenRequest {
  sessionId: string;
  direction: "inbound" | "outbound";
  content: string;
  /** Optional: user making the agent request (for egress ACL checks). */
  userId?: string;
  /** Optional: metadata about the source (tool name, file path, etc.). */
  source?: {
    kind: string;
    name?: string;
  };
}

/** Response body for POST /v1/screen */
export interface ScreenResponse {
  verdict: Verdict;
  /** Present when decision is "escalate"; long-poll GET /v1/verdict/:id/wait. */
  escalationId?: string;
}
