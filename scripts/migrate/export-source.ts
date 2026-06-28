/**
 * Export a source site's editorial data via its REST API into NDJSON files, ready
 * for import-central.ts. Runs against a LIVE source site (brief-asia / dtw-web) —
 * no cross-repo imports needed. Exports all locales (locale=all) and both
 * published + draft docs.
 *
 *   SOURCE_URL=https://briefasia.com \
 *   SOURCE_ADMIN_EMAIL=... SOURCE_ADMIN_PASSWORD=... \
 *   EXPORT_TENANT=brief-asia \
 *   npm run migrate:export -- [--dry-run]
 *
 * Override the collection list with EXPORT_COLLECTIONS=pillars,tags,articles,...
 */
import "../lib/env";
import { DRY_RUN, requireEnv } from "../lib/env";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SOURCE_URL = requireEnv("SOURCE_URL").replace(/\/$/, "");
const EMAIL = requireEnv("SOURCE_ADMIN_EMAIL");
const PASSWORD = requireEnv("SOURCE_ADMIN_PASSWORD");
const TENANT = requireEnv("EXPORT_TENANT");
const OUT_DIR = process.env.EXPORT_DIR || path.resolve(process.cwd(), "migration-data", TENANT);

// Versioned collections (drafts) — exported with draft=true too.
const VERSIONED = new Set(["articles"]);

const DEFAULT_COLLECTIONS = [
  "pillars",
  "sectors",
  "tags",
  "authors",
  "media",
  "articles",
  "newsletters",
  "podcasts",
  "corrections",
  "sponsorSlots",
  "marketSnapshots",
  "fxRates",
  "trendingBlocks",
  "wireDrops",
  "engineConflictLog",
];

const COLLECTIONS = (process.env.EXPORT_COLLECTIONS || DEFAULT_COLLECTIONS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function login(): Promise<string> {
  const res = await fetch(`${SOURCE_URL}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("login returned no token");
  return data.token;
}

async function fetchAll(token: string, collection: string, draft: boolean): Promise<unknown[]> {
  const docs: unknown[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({ depth: "0", limit: "100", page: String(page), locale: "all" });
    if (draft) params.set("draft", "true");
    const res = await fetch(`${SOURCE_URL}/api/${collection}?${params}`, {
      headers: { Authorization: `JWT ${token}` },
    });
    if (!res.ok) throw new Error(`fetch ${collection} p${page}: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { docs: unknown[]; totalPages: number };
    docs.push(...json.docs);
    if (page >= (json.totalPages || 1)) break;
    page += 1;
  }
  return docs;
}

async function main() {
  const token = await login();
  if (!DRY_RUN) mkdirSync(OUT_DIR, { recursive: true });

  for (const collection of COLLECTIONS) {
    try {
      const published = await fetchAll(token, collection, false);
      const drafts = VERSIONED.has(collection) ? await fetchAll(token, collection, true) : [];
      // Merge by id, preferring the draft view (it carries the latest unpublished state).
      const byId = new Map<unknown, unknown>();
      for (const d of published) byId.set((d as { id: unknown }).id, d);
      for (const d of drafts) byId.set((d as { id: unknown }).id, d);
      const merged = [...byId.values()];

      if (DRY_RUN) {
        console.log(`[export] ${collection}: ${merged.length} docs (dry-run, not written)`);
        continue;
      }
      const file = path.join(OUT_DIR, `${collection}.ndjson`);
      writeFileSync(file, merged.map((d) => JSON.stringify(d)).join("\n") + "\n", "utf8");
      console.log(`[export] ${collection}: ${merged.length} docs → ${file}`);
    } catch (err) {
      console.warn(`[export] ${collection} skipped: ${(err as Error).message}`);
    }
  }
  console.log(`[export] done (tenant=${TENANT}, out=${OUT_DIR})`);
}

main().catch((err) => {
  console.error("[export] failed", err);
  process.exit(1);
});
