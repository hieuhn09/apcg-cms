/**
 * Create AsiaMaterialsBrief's (tenant `amb`) six legacy exhibition booths in
 * Central's `booths` collection, from `scripts/lib/amb-legacy-booths.ts`
 * (owner-approved mapping 27/28-10-26: legacy slugs kept, published, tier
 * basic, not verified, studios -> design-studios). The one legacy booth
 * application (personal contact data) is NOT migrated. Guard behaviour mirrors
 * `scripts/audit/add-amb-taxonomy.ts` exactly.
 *
 * OWNER-RUN. DRY-RUN by default: writes nothing without `--apply`. Run it AFTER
 * the `amb` tenant exists with Exhibition ON, and after the
 * `20261027_000000_add_amb_booth_halls` migration has run in production (the
 * script checks both, read-only, and refuses otherwise). It is NOT part of seed.
 *   - booth absent (tenant amb + slug) -> `create`;
 *   - booth present                    -> `exists`, NEVER overwritten.
 * Re-running is idempotent; a second run prints `nothing to create`.
 *
 * Database safety, in this order, BEFORE the Payload config is imported:
 *   1. the database NAME is printed first:
 *        database name (new URL(DATABASE_URL).pathname): "/neondb"
 *   2. host guard (scripts/lib/local-db-guard.ts): a local DATABASE_URL runs as
 *      is; a NON-local host is refused unless `--confirm-host=<exact DB hostname>`
 *      equals the parsed HOSTNAME (no port); `--apply` against a non-local host
 *      also needs an interactive terminal (TTY);
 *   3. name guard (scripts/lib/central-db-name-guard.ts): for a NON-local host
 *      (dry run AND --apply) the database must be exactly `/neondb`.
 * Print host and name by hand first:
 *   node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname,u.pathname)'
 * A tunnelled production DB on localhost looks local: never run with a tunnel open.
 *
 * Creates go through the Payload Local API with the tenant id set, so the
 * Booths `hall` validate (src/hooks/booth-hall.ts, per-tenant allowlist) and the
 * per-tenant slug uniqueness hook run. They pass `context.disableRevalidate`, so
 * no frontend webhook fires; reader caches refresh by their ISR window.
 * Result log: migration-data/ (gitignored).
 *
 *   npm run audit:add-amb-booths                                          # dry run
 *   npm run audit:add-amb-booths -- --apply                               # local DB
 *   npm run audit:add-amb-booths -- --apply --confirm-host=<prod DB hostname>
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import { assertLocalOrConfirmed, LocalDbGuardError } from "../lib/local-db-guard";
import { assertCentralDbName, CentralDbNameError, databaseNameBanner } from "../lib/central-db-name-guard";
import { pCreate, pFind } from "../lib/payload-loose";
import {
  AMB_BOOTHS_TENANT_SLUG,
  AMB_LEGACY_BOOTHS,
  hallsNeeded,
  planAmbBooths,
  validateAmbLegacyBooths,
} from "../lib/amb-legacy-booths";

const TAG = "[add-amb-booths]";

/* ── Database name FIRST (hard rule: print it before anything else) ───────── */

console.log(`${TAG} ${databaseNameBanner(process.env.DATABASE_URL)}`);

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const USAGE =
  "Usage:\n" +
  "  npm run audit:add-amb-booths [-- --apply] [-- --confirm-host=<exact DB hostname>]\n" +
  "\n" +
  "  (no flags)              dry run: print the tenant preflight and the create / exists plan\n" +
  "  --apply                 create the booths planned as `create` (never updates an existing booth)\n" +
  "  --confirm-host=<host>   required for a NON-local DATABASE_URL; must equal its HOSTNAME (no port);\n" +
  "                          a non-local database must also be named exactly /neondb:\n" +
  "                          node -e 'const u=new URL(process.env.DATABASE_URL);console.log(u.hostname,u.pathname)'\n" +
  "                          --apply against a non-local host also needs a TTY.\n" +
  "\n" +
  "Run only after the amb tenant exists in /admin with Exhibition ON.\n";

function usage(message?: string): never {
  if (message) console.error(`\n${message}\n`);
  console.error(USAGE);
  process.exit(message ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) usage();
const APPLY = argv.includes("--apply");
const confirmArgs = argv.filter((a) => a.startsWith("--confirm-host="));
const unknown = argv.filter((a) => a !== "--apply" && !a.startsWith("--confirm-host="));
if (unknown.length) usage(`Unknown argument(s): ${unknown.join(", ")}`);
if (confirmArgs.length > 1) usage("Pass --confirm-host at most once.");
const CONFIRM_HOST = confirmArgs[0]?.slice("--confirm-host=".length);

/* ── Database guards (before the Payload config is imported) ─────────────── */

let target: ReturnType<typeof assertLocalOrConfirmed>;
try {
  target = assertLocalOrConfirmed(process.env.DATABASE_URL, CONFIRM_HOST, process.stdin.isTTY === true, APPLY);
  assertCentralDbName(process.env.DATABASE_URL, target);
} catch (err) {
  console.error(
    err instanceof LocalDbGuardError || err instanceof CentralDbNameError ? err.message : "database guard: refusing.",
  );
  usage("Refusing to run.");
}
// Never let Payload's dev schema push touch a non-local database.
if (!target.local) process.env.PAYLOAD_DB_PUSH = "false";

/* ── Helpers ─────────────────────────────────────────────────────────────── */

type Doc = Record<string, unknown> & { id: number | string };

function writeResultLog(result: Record<string, unknown>): string {
  const dir = path.resolve(process.cwd(), "migration-data");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `add-amb-booths.applied-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const problems = validateAmbLegacyBooths();
  if (problems.length) {
    console.error(`${TAG} embedded booth data is invalid (nothing done):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }

  console.log(`${TAG} database ${target.banner} (${target.local ? "local" : "NON-LOCAL, confirmed, name /neondb"}) - ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);

  const { getPayload } = await import("payload");
  const { sql } = await import("@payloadcms/db-postgres");
  const { default: payloadConfig } = await import("@payload-config");
  const payload = await getPayload({ config: payloadConfig });

  /* Tenant preflight (read-only). */
  const tenant = (await pFind(payload, "tenants", { where: { slug: { equals: AMB_BOOTHS_TENANT_SLUG } }, limit: 1 })).docs[0] as unknown as Doc | undefined;
  if (!tenant) {
    console.error(`${TAG} tenant "${AMB_BOOTHS_TENANT_SLUG}" not found: create it by hand in /admin first (docs/07-website-management.md). Nothing done.`);
    process.exit(1);
  }
  const features = (tenant.features ?? {}) as Record<string, unknown>;
  console.log(`${TAG} tenant preflight (id ${String(tenant.id)}): status ${JSON.stringify(tenant.status ?? null)}, features ${JSON.stringify(features)}`);
  if (features.exhibition !== true) {
    console.error(
      `${TAG} tenant "${AMB_BOOTHS_TENANT_SLUG}" has features.exhibition OFF: tick "Exhibition" on the tenant in /admin first ` +
        "(booths of a tenant without it are hidden in admin and 404 on /api/public/booths). Nothing done.",
    );
    process.exit(1);
  }

  /* Hall enum preflight (read-only): the 20261027 migration adds the amb hall values. */
  const db = (payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<{ rows?: Array<{ v: string }> }> } }).drizzle;
  const enumRows = (await db.execute(sql`SELECT unnest(enum_range(NULL::"public"."enum_booths_hall"))::text AS v`)).rows ?? [];
  const enumValues = new Set(enumRows.map((r) => r.v));
  const missingHalls = hallsNeeded().filter((h) => !enumValues.has(h));
  if (missingHalls.length) {
    console.error(
      `${TAG} the database hall enum lacks ${missingHalls.join(", ")}: migration 20261027_000000_add_amb_booth_halls has not run here ` +
        "(it runs at the next production deploy). Nothing done.",
    );
    process.exit(1);
  }

  /* Existing booths of tenant amb, matched by slug. */
  const slugs = AMB_LEGACY_BOOTHS.map((b) => b.slug);
  const existingDocs = (await pFind(payload, "booths", {
    where: { and: [{ tenant: { equals: tenant.id } }, { slug: { in: slugs } }] },
    limit: 0,
    pagination: false,
  })) as unknown as { docs: Doc[] };
  const items = planAmbBooths(existingDocs.docs.map((d) => String(d.slug)));
  const toCreate = items.filter((i) => i.action === "create");
  const existing = items.filter((i) => i.action === "exists");
  console.log(`${TAG} plan: ${toCreate.length} create, ${existing.length} exists (${items.length} booths)`);
  for (const i of items) {
    const d = i.data;
    const label = `booths ${i.slug}  [${d.hall}] ${d.name}${d.city || d.country ? ` (${[d.city, d.country].filter(Boolean).join(", ")})` : ""}`;
    console.log(`  ${i.action === "create" ? "create " : "exists "} ${label}${i.action === "exists" ? " (never overwritten)" : ""}`);
  }
  console.log("  NOTE: no logo, catalog, inquiry email or related articles are set; the legacy booth application is not migrated.");

  if (!APPLY) {
    if (toCreate.length) console.log(`${TAG} DRY RUN: re-run with --apply to create ${toCreate.length} booth(s).`);
    else console.log(`${TAG} DRY RUN: nothing to create.`);
    process.exit(0);
  }

  /* Apply. Stop at the first error. */
  const created: Array<{ slug: string; id: unknown }> = [];
  const ctx = { context: { disableRevalidate: true } };
  let failure: string | undefined;
  try {
    for (const i of toCreate) {
      const doc = (await pCreate(payload, "booths", { tenant: tenant.id, ...i.data }, ctx)) as unknown as Doc;
      created.push({ slug: i.slug, id: doc.id });
      console.log(`  created booths ${i.slug} (id ${String(doc.id)})`);
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  const log = writeResultLog({
    outcome: failure ? "partial" : "applied",
    tenant: AMB_BOOTHS_TENANT_SLUG,
    host: target.banner,
    created,
    skippedExisting: existing.map((i) => i.slug),
    error: failure ?? null,
  });
  if (failure) {
    console.error(`${TAG} FAILED after ${created.length} create(s): ${failure}. Re-run to complete (idempotent). Result log: ${log}`);
    process.exit(1);
  }
  console.log(`${TAG} created ${created.length} booth(s); ${existing.length} already existed (never overwritten).`);
  console.log(`${TAG} note: no revalidate webhook was sent; reader caches refresh by their ISR window.`);
  console.log(`${TAG} result log: ${log}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${TAG} failed:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
