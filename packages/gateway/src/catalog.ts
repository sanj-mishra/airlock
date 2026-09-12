import { Nango } from "@nangohq/node";
import type { CatalogDocument, CatalogLookup, Sensitivity } from "@airlock/shared";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SECRET_KEY = process.env.NANGO_SECRET_KEY;
const DRIVE_PROVIDER_KEY = process.env.NANGO_DRIVE_PROVIDER_KEY ?? "google-drive";
const DRIVE_CONNECTION_ID = process.env.NANGO_DRIVE_CONNECTION_ID;
const OKTA_PROVIDER_KEY = process.env.NANGO_OKTA_PROVIDER_KEY ?? "okta";
const OKTA_CONNECTION_ID = process.env.NANGO_OKTA_CONNECTION_ID;
const OKTA_USER_ID = process.env.NANGO_OKTA_USER_ID ?? "me";

/** Egress screening hits this per outbound call — don't re-fetch Drive every time. */
const CACHE_TTL_MS = Number(process.env.CATALOG_TTL_MS ?? 60_000);
let cache: { at: number; value: CatalogLookup } | null = null;

/**
 * Hackathon sensitivity mapping. Drive has no native sensitivity field, so we
 * prefer an explicit `appProperties.sensitivity` on the file and fall back to
 * a title heuristic. Swap for the Drive Labels API if there's time.
 */
const SENSITIVITY_HINTS: Array<[RegExp, Sensitivity]> = [
  [/\b(acquisition|m&a|term sheet|cap table|board deck|diligence)\b/i, "confidential"],
  [/\b(salary|comp band|offer letter|performance review|ssn)\b/i, "restricted"],
  [/\b(handbook|onboarding|policy|runbook|checklist)\b/i, "internal"],
];

const SENSITIVITIES: Sensitivity[] = ["public", "internal", "confidential", "restricted"];

function inferSensitivity(title: string, declared?: string): Sensitivity {
  if (declared && (SENSITIVITIES as string[]).includes(declared)) {
    return declared as Sensitivity;
  }
  for (const [pattern, level] of SENSITIVITY_HINTS) {
    if (pattern.test(title)) return level;
  }
  return "internal";
}

export function loadFixtureCatalog(): CatalogLookup {
  const fixturePath = join(__dirname, "../../../fixtures/catalog.json");
  return JSON.parse(readFileSync(fixturePath, "utf8")) as CatalogLookup;
}

interface DriveFile {
  id: string;
  name: string;
  appProperties?: Record<string, string>;
}

async function fetchDriveDocuments(nango: Nango): Promise<CatalogDocument[]> {
  const res = await nango.get({
    endpoint: "/drive/v3/files",
    providerConfigKey: DRIVE_PROVIDER_KEY,
    connectionId: DRIVE_CONNECTION_ID!,
    params: {
      pageSize: 50,
      fields: "files(id,name,appProperties)",
      q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
    },
  });

  const files: DriveFile[] = res.data?.files ?? [];
  return files.map((file) => ({
    id: file.id,
    source: "gdrive" as const,
    title: file.name,
    sensitivity: inferSensitivity(file.name, file.appProperties?.sensitivity),
    ownerGroups: (file.appProperties?.ownerGroups ?? "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
  }));
}

async function fetchOktaGroups(nango: Nango): Promise<string[]> {
  const res = await nango.get({
    endpoint: `/api/v1/users/${OKTA_USER_ID}/groups`,
    providerConfigKey: OKTA_PROVIDER_KEY,
    connectionId: OKTA_CONNECTION_ID!,
  });

  const groups: Array<{ profile?: { name?: string } }> = res.data ?? [];
  return groups.map((g) => g.profile?.name).filter((n): n is string => Boolean(n));
}

/**
 * Live catalog with fixture fallback, per PLAN.md: Drive first, Okta second,
 * and never let a connector outage take the demo down.
 */
export async function loadCatalog(): Promise<CatalogLookup> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const fixture = loadFixtureCatalog();

  if (!SECRET_KEY || !DRIVE_CONNECTION_ID) {
    return fixture;
  }

  const nango = new Nango({ secretKey: SECRET_KEY });
  const value: CatalogLookup = { ...fixture };

  try {
    value.documents = await fetchDriveDocuments(nango);
  } catch (err) {
    console.warn("[catalog] Drive fetch failed, using fixture documents:", err);
  }

  if (OKTA_CONNECTION_ID) {
    try {
      value.oktaGroups = await fetchOktaGroups(nango);
    } catch (err) {
      console.warn("[catalog] Okta fetch failed, using fixture groups:", err);
    }
  }

  cache = { at: Date.now(), value };
  return value;
}

/** Which sources are actually live — surfaced on /v1/catalog for the demo. */
export function catalogSources() {
  return {
    drive: Boolean(SECRET_KEY && DRIVE_CONNECTION_ID) ? "nango" : "fixture",
    okta: Boolean(SECRET_KEY && OKTA_CONNECTION_ID) ? "nango" : "fixture",
  };
}
