/**
 * Create the GlobalTravelPost (tenant `gtp`) taxonomy: 6 pillars, 20
 * sub-sections (21 with `--include-gtp-events`), 2 newsletters, 6 authors and
 * 6 tags (40 rows), all from `scripts/lib/gtp-taxonomy.ts`. gtp-launch P1.
 *
 * OWNER-RUN. DRY-RUN by default: writes nothing without `--apply`. Run it AFTER
 * the `gtp` tenant exists (created by hand in /admin). It is NOT part of seed.
 *   - row absent  -> `create` (dry run prints it; `--apply` creates it);
 *   - row present -> `exists`; field differences are printed and NEVER written;
 *   - unsafe state -> `refuse` (e.g. press-room with sub-sections, an author
 *     name with another slug, a rank/slug owned by another author, a tag slug
 *     with another title); the run then writes NOTHING and exits 1.
 * Every lookup is scoped to tenant `gtp`. Re-running is idempotent.
 *
 * Tenant preflight (read-only, always printed): FAIL when
 * `autoPublishEngineDrafts` is true or `features.articles` is off (`--apply`
 * refuses); WARN when `supportedLanguages` is not exactly ["en"],
 * `features.newsletters` is off, or `frontendUrl` is set.
 *
 * Database safety (scripts/lib/local-db-guard.ts): a local DATABASE_URL runs as
 * is. A NON-local host is refused unless `--confirm-host=<exact DB hostname>`
 * equals the parsed HOSTNAME (no port); print it with
 *   node -e 'console.log(new URL(process.env.DATABASE_URL).hostname)'
 * and pass exactly that. `--apply` against a non-local host also needs an
 * interactive terminal. A tunnelled production DB on localhost looks local:
 * never run with a tunnel open.
 *
 * Creates pass `context.disableRevalidate`, so no frontend webhook fires; reader
 * caches refresh by their ISR window. Result log: migration-data/ (gitignored).
 *
 *   npm run audit:add-gtp-taxonomy                                              # dry run
 *   npm run audit:add-gtp-taxonomy -- --apply                                   # local DB
 *   npm run audit:add-gtp-taxonomy -- --apply --confirm-host=<prod DB hostname> [--authors-file=./gtp-authors.json]
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import type { Payload } from "payload";
import { assertLocalOrConfirmed, LocalDbGuardError } from "../lib/local-db-guard";
import { pCreate, pFind } from "../lib/payload-loose";
import {
  GTP_TENANT_SLUG,
  buildGtpFixture,
  parseAuthorsFile,
  planCounts,
  planGtp,
  validateGtpFixture,
  type AuthorOverrides,
  type GtpAuthor,
  type GtpExisting,
  type GtpNewsletter,
  type GtpPillar,
  type GtpSubSection,
  type GtpTag,
  type PlanItem,
} from "../lib/gtp-taxonomy";

const TAG = "[add-gtp-taxonomy]";

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const USAGE =
  "Usage:\n" +
  "  npm run audit:add-gtp-taxonomy [-- --apply] [-- --confirm-host=<exact DB hostname>]\n" +
  "                                 [-- --authors-file=<path>] [-- --include-gtp-events]\n" +
  "\n" +
  "  (no flags)              dry run: print the tenant preflight and the create / exists / refuse plan\n" +
  "  --apply                 create the rows planned as `create` (never updates an existing row)\n" +
  "  --confirm-host=<host>   required for a NON-local DATABASE_URL; must equal its HOSTNAME (no port):\n" +
  "                          node -e 'console.log(new URL(process.env.DATABASE_URL).hostname)'\n" +
  "                          --apply against a non-local host also needs a TTY.\n" +
  '  --authors-file=<path>   JSON { "<author-slug>": { "role"?, "bio"?, "city"?, "slug"? } }\n' +
  "  --include-gtp-events    also create the optional events-awards/gtp-events sub-section\n" +
  "\n" +
  "Run only after the gtp tenant exists in /admin.\n";

function usage(message?: string): never {
  if (message) console.error(`\n${message}\n`);
  console.error(USAGE);
  process.exit(message ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) usage();
const APPLY = argv.includes("--apply");
const INCLUDE_GTP_EVENTS = argv.includes("--include-gtp-events");
const confirmArgs = argv.filter((a) => a.startsWith("--confirm-host="));
const authorsArgs = argv.filter((a) => a.startsWith("--authors-file="));
const unknown = argv.filter(
  (a) => a !== "--apply" && a !== "--include-gtp-events" && !a.startsWith("--confirm-host=") && !a.startsWith("--authors-file="),
);
if (unknown.length) usage(`Unknown argument(s): ${unknown.join(", ")}`);
if (confirmArgs.length > 1) usage("Pass --confirm-host at most once.");
if (authorsArgs.length > 1) usage("Pass --authors-file at most once.");
const CONFIRM_HOST = confirmArgs[0]?.slice("--confirm-host=".length);
const AUTHORS_FILE = authorsArgs[0]?.slice("--authors-file=".length);

/* ── Database guard (before the Payload config is imported) ──────────────── */

let target: ReturnType<typeof assertLocalOrConfirmed>;
try {
  target = assertLocalOrConfirmed(process.env.DATABASE_URL, CONFIRM_HOST, process.stdin.isTTY === true, APPLY);
} catch (err) {
  console.error(err instanceof LocalDbGuardError ? err.message : "local-db guard: refusing.");
  usage("Refusing to run.");
}
// Never let Payload's dev schema push touch a non-local database.
if (!target.local) process.env.PAYLOAD_DB_PUSH = "false";

/* ── Helpers ─────────────────────────────────────────────────────────────── */

type Doc = Record<string, unknown> & { id: number | string };

const relId = (v: unknown): unknown => (v !== null && typeof v === "object" ? (v as { id?: unknown }).id : v);

async function pCount(payload: Payload, collection: string, where: Record<string, unknown>): Promise<number> {
  const r = await payload.count({ collection: collection as never, where: where as never, overrideAccess: true } as never);
  return (r as { totalDocs: number }).totalDocs;
}

async function findAll(payload: Payload, collection: string, tenantId: unknown): Promise<Doc[]> {
  const r = await pFind(payload, collection, { where: { tenant: { equals: tenantId } }, limit: 0, pagination: false });
  return (r as { docs: Doc[] }).docs;
}

function writeResultLog(result: Record<string, unknown>): string {
  const dir = path.resolve(process.cwd(), "migration-data");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `add-gtp-taxonomy.applied-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

function loadAuthorOverrides(): AuthorOverrides | undefined {
  if (!AUTHORS_FILE) return undefined;
  try {
    return parseAuthorsFile(fs.readFileSync(AUTHORS_FILE, "utf8"));
  } catch (err) {
    usage(`--authors-file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const overrides = loadAuthorOverrides();
  const fixture = buildGtpFixture({ includeGtpEvents: INCLUDE_GTP_EVENTS, authorOverrides: overrides });
  const problems = validateGtpFixture(fixture);
  if (problems.length) {
    console.error(`${TAG} fixture is invalid (nothing done):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }

  console.log(`${TAG} database ${target.banner} (${target.local ? "local" : "NON-LOCAL, confirmed"}) - ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);

  const { getPayload } = await import("payload");
  const { default: payloadConfig } = await import("@payload-config");
  const payload = await getPayload({ config: payloadConfig });

  /* Tenant preflight (read-only). */
  const tenant = (await pFind(payload, "tenants", { where: { slug: { equals: GTP_TENANT_SLUG } }, limit: 1 })).docs[0] as Doc | undefined;
  if (!tenant) {
    console.error(`${TAG} tenant "${GTP_TENANT_SLUG}" not found: create it in /admin first (plan section 7). Nothing done.`);
    process.exit(1);
  }
  const features = (tenant.features ?? {}) as Record<string, unknown>;
  console.log(`${TAG} tenant preflight (id ${String(tenant.id)}):`);
  for (const k of ["status", "domain", "frontendUrl", "supportedLanguages", "autoPublishEngineDrafts"]) {
    console.log(`  ${k}: ${JSON.stringify(tenant[k] ?? null)}`);
  }
  console.log(`  features: ${JSON.stringify(features)}`);
  const fails: string[] = [];
  if (tenant.autoPublishEngineDrafts === true) fails.push("autoPublishEngineDrafts is true (must be false: every gtp piece is editor-reviewed)");
  if (!features.articles) fails.push("features.articles is off");
  const langs = tenant.supportedLanguages;
  if (!(Array.isArray(langs) && langs.length === 1 && langs[0] === "en")) console.log(`  WARN: supportedLanguages is not exactly ["en"]`);
  if (!features.newsletters) console.log("  WARN: features.newsletters is off (newsletter rows would not be served by /api/public/newsletters)");
  if (typeof tenant.frontendUrl === "string" && tenant.frontendUrl !== "") {
    console.log(`  WARN: frontendUrl is set (${tenant.frontendUrl}); check it is a known preview/production host`);
  }
  for (const f of fails) console.log(`  FAIL: ${f}`);

  /* Existing rows (tenant-scoped). */
  const pillarDocs = await findAll(payload, "pillars", tenant.id);
  const pillarSlugById = new Map(pillarDocs.map((p) => [String(p.id), String(p.slug)]));
  const existing: GtpExisting = {
    pillars: await Promise.all(
      pillarDocs.map(async (p) => ({
        ...p,
        slug: String(p.slug),
        subSectionCount: await pCount(payload, "subsections", { pillar: { equals: p.id } }),
        secondaryRefCount: await pCount(payload, "articles", { "secondarySections.pillar": { equals: p.id } }),
      })),
    ),
    subSections: (await findAll(payload, "subsections", tenant.id)).map((s) => ({
      ...s,
      slug: String(s.slug),
      pillarSlug: pillarSlugById.get(String(relId(s.pillar))) ?? "",
    })),
    newsletters: (await findAll(payload, "newsletters", tenant.id)).map((n) => ({ ...n, slug: String(n.slug) })),
    authors: (await findAll(payload, "authors", tenant.id)).map((a) => ({
      ...a,
      name: String(a.name),
      slug: (a.slug as string | null | undefined) ?? null,
      rank: (a.rank as number | null | undefined) ?? null,
    })),
    tags: (await findAll(payload, "tags", tenant.id)).map((t) => ({ ...t, slug: String(t.slug) })),
  };

  const items = planGtp(fixture, existing);
  const counts = planCounts(items);
  console.log(`${TAG} plan: ${counts.create} create, ${counts.exists} exists, ${counts.refuse} refuse (${items.length} rows)`);
  for (const i of items) {
    const a = i.action;
    if (a.kind === "create") console.log(`  create  ${i.entity} ${i.key}`);
    else if (a.kind === "refuse") console.log(`  REFUSE  ${i.entity} ${i.key}: ${a.reason}`);
    else {
      console.log(`  exists  ${i.entity} ${i.key}${a.diffs.length ? " (differs; never overwritten)" : ""}`);
      for (const d of a.diffs) console.log(`          ${d.field}: current ${JSON.stringify(d.current)}  fixture ${JSON.stringify(d.fixture)}`);
    }
  }
  const missing = fixture.authors.filter((a) => !a.bio || !a.city).map((a) => a.name);
  if (missing.length) console.log(`  WARN: authors still lacking bio/city (owner inputs, set in /admin or --authors-file): ${missing.join(", ")}`);

  if (!APPLY) {
    if (fails.length || counts.refuse) console.log(`${TAG} DRY RUN: --apply would REFUSE (preflight FAIL or refused rows).`);
    else if (counts.create) console.log(`${TAG} DRY RUN: re-run with --apply to create ${counts.create} row(s).`);
    else console.log(`${TAG} DRY RUN: nothing to create.`);
    process.exit(fails.length || counts.refuse ? 1 : 0);
  }

  if (fails.length || counts.refuse) {
    console.error(`${TAG} REFUSING --apply: ${fails.length} preflight failure(s), ${counts.refuse} refused row(s). Nothing written.`);
    writeResultLog({ outcome: "refused", tenant: GTP_TENANT_SLUG, host: target.banner, fails, refusals: refusals(items) });
    process.exit(1);
  }

  /* Apply: pillars, sub-sections, newsletters, authors, tags. Stop at the first error. */
  const created: Array<{ entity: string; key: string; id: unknown }> = [];
  const ctx = { context: { disableRevalidate: true } };
  const pillarId = new Map<string, unknown>(pillarDocs.map((p) => [String(p.slug), p.id]));
  const toCreate = (entity: PlanItem["entity"]) => items.filter((i) => i.entity === entity && i.action.kind === "create");
  let failure: string | undefined;
  try {
    for (const i of toCreate("pillars")) {
      const p = i.row as GtpPillar;
      const doc = (await pCreate(
        payload,
        "pillars",
        { tenant: tenant.id, slug: p.slug, title: p.title, heading: p.heading, description: p.description, order: p.order, color: p.color, icon: p.icon },
        ctx,
      )) as Doc;
      pillarId.set(p.slug, doc.id);
      created.push({ entity: i.entity, key: i.key, id: doc.id });
    }
    for (const i of toCreate("subsections")) {
      const s = i.row as GtpSubSection;
      const pid = pillarId.get(s.pillarSlug);
      if (pid === undefined) throw new Error(`pillar ${s.pillarSlug} has no id`);
      const doc = (await pCreate(payload, "subsections", { tenant: tenant.id, pillar: pid, slug: s.slug, title: s.title, order: s.order }, ctx)) as Doc;
      created.push({ entity: i.entity, key: i.key, id: doc.id });
    }
    for (const i of toCreate("newsletters")) {
      const n = i.row as GtpNewsletter;
      const doc = (await pCreate(
        payload,
        "newsletters",
        { tenant: tenant.id, slug: n.slug, name: n.name, cadence: n.cadence, description: n.description, order: n.order, active: n.active },
        ctx,
      )) as Doc;
      created.push({ entity: i.entity, key: i.key, id: doc.id });
    }
    for (const i of toCreate("authors")) {
      const a = i.row as GtpAuthor;
      const data: Record<string, unknown> = { tenant: tenant.id, name: a.name, slug: a.slug, role: a.role };
      if (a.rank !== undefined) data.rank = a.rank;
      if (a.bio) data.bio = a.bio;
      if (a.city) data.city = a.city;
      const doc = (await pCreate(payload, "authors", data, ctx)) as Doc;
      created.push({ entity: i.entity, key: i.key, id: doc.id });
    }
    for (const i of toCreate("tags")) {
      const t = i.row as GtpTag;
      const doc = (await pCreate(payload, "tags", { tenant: tenant.id, slug: t.slug, title: t.title }, ctx)) as Doc;
      created.push({ entity: i.entity, key: i.key, id: doc.id });
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  const skipped = items
    .filter((i) => i.action.kind === "exists")
    .map((i) => ({ entity: i.entity, key: i.key, diffs: i.action.kind === "exists" ? i.action.diffs : [] }));
  const log = writeResultLog({
    outcome: failure ? "partial" : "applied",
    tenant: GTP_TENANT_SLUG,
    host: target.banner,
    created,
    skippedExisting: skipped,
    error: failure ?? null,
  });
  if (failure) {
    console.error(`${TAG} FAILED after ${created.length} create(s): ${failure}. Re-run to complete (idempotent). Result log: ${log}`);
    process.exit(1);
  }
  console.log(`${TAG} created ${created.length} row(s); ${skipped.length} already existed (never overwritten).`);
  console.log(`${TAG} note: no revalidate webhook was sent; reader caches refresh by their ISR window.`);
  console.log(`${TAG} result log: ${log}`);
  process.exit(0);
}

function refusals(items: PlanItem[]) {
  return items.filter((i) => i.action.kind === "refuse").map((i) => ({ entity: i.entity, key: i.key, reason: i.action.kind === "refuse" ? i.action.reason : "" }));
}

main().catch((err) => {
  console.error(`${TAG} failed:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
