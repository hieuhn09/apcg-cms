/**
 * Create the BriefAsia `pressroom` pillar — the single-home pillar keyed in
 * SINGLE_HOME_PILLARS (src/lib/constants.ts). OWNER-RUN, and LAST in the
 * rollout: only after BOTH the CMS and the FE deploys are Ready (a row created
 * earlier would leak Pressroom into the FE home hero).
 *
 * DRY-RUN by default; writes nothing without `--apply`. Idempotent:
 *   - row absent  -> dry-run prints the create payload; `--apply` creates it
 *                    (fires the pillars:all / articles:all revalidation hooks +
 *                    the signed frontend webhook);
 *   - row present -> prints field differences vs the defaults, NEVER
 *                    overwrites, exits 0;
 *   - row present with sub-sections or secondary-section references -> refuses
 *                    (the single-home rule forbids both) and changes nothing.
 * Every lookup is filtered by tenant `brief-asia` (WAD has its own, unrelated
 * `pressroom` pillar).
 *
 * Database safety (scripts/lib/local-db-guard.ts): a local DATABASE_URL runs as
 * is. A NON-local host is refused unless `--confirm-host=<exact DB hostname>`
 * equals the parsed host, and `--apply` against it additionally needs an
 * interactive terminal. `--confirm-host` is a typo guard, not an authorisation.
 * A tunnelled production DB on localhost looks local: never run with a tunnel
 * open.
 *
 *   npm run audit:add-pressroom                                            # dry run
 *   npm run audit:add-pressroom -- --apply                                 # local DB
 *   npm run audit:add-pressroom -- --apply --confirm-host=<prod DB host>   # owner, prod, LAST
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import type { Payload } from "payload";
import { assertLocalOrConfirmed, LocalDbGuardError } from "../lib/local-db-guard";
import { pCreate, pFind } from "../lib/payload-loose";

const TENANT_SLUG = "brief-asia";
const PILLAR_SLUG = "pressroom";
const FALLBACK_ORDER = 9;
const DEFAULTS = {
  title: "Pressroom",
  navLabel: "Pressroom",
  heading: "Pressroom",
  color: "var(--accent)",
  icon: "newspaper",
  description: "Press releases and official announcements.",
} as const;

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const USAGE =
  "Usage:\n" +
  "  npm run audit:add-pressroom [-- --apply] [-- --confirm-host=<exact DB hostname>]\n" +
  "\n" +
  "  (no flags)              dry run: print what would be created / the field diff\n" +
  "  --apply                 create the brief-asia `pressroom` pillar if absent\n" +
  "  --confirm-host=<host>   required for a NON-local DATABASE_URL; must equal its host.\n" +
  "                          --apply against a non-local host also needs a TTY.\n" +
  "\n" +
  "Run against production only after BOTH the CMS and FE deploys are Ready.\n";

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

/* ── Database guard (before the Payload config is imported) ──────────────── */

let target: ReturnType<typeof assertLocalOrConfirmed>;
try {
  target = assertLocalOrConfirmed(process.env.DATABASE_URL, CONFIRM_HOST, process.stdin.isTTY === true, APPLY);
} catch (err) {
  console.error(err instanceof LocalDbGuardError ? err.message : "local-db guard: refusing.");
  usage("Refusing to run.");
}
// Never let Payload's dev schema push touch a non-local database (G82).
if (!target.local) process.env.PAYLOAD_DB_PUSH = "false";

/* ── Helpers ─────────────────────────────────────────────────────────────── */

async function pCount(payload: Payload, collection: string, where: Record<string, unknown>): Promise<number> {
  const r = await payload.count({ collection: collection as never, where: where as never, overrideAccess: true } as never);
  return (r as { totalDocs: number }).totalDocs;
}

const relId = (v: unknown): unknown => (v !== null && typeof v === "object" ? (v as { id?: unknown }).id : v);

function writeResultLog(result: Record<string, unknown>): string {
  const dir = path.resolve(process.cwd(), "migration-data");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `add-pressroom-pillar.applied-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log(`[add-pressroom] database ${target.banner} (${target.local ? "local" : "NON-LOCAL, confirmed"}) — ${APPLY ? "APPLY" : "DRY RUN (no writes)"}`);
  if (!process.env.CENTRAL_SIGNING_SECRET) {
    console.warn(
      "[add-pressroom] WARN: CENTRAL_SIGNING_SECRET is not set — the signed frontend webhook will be skipped;\n" +
        "                the FE nav link then appears only after its 300 s `pillars:all` cache window.",
    );
  }

  const { getPayload } = await import("payload");
  const { default: payloadConfig } = await import("@payload-config");
  const payload = await getPayload({ config: payloadConfig });

  const tenant = (await pFind(payload, "tenants", { where: { slug: { equals: TENANT_SLUG } }, limit: 1 })).docs[0] as
    | { id: number | string }
    | undefined;
  if (!tenant) {
    console.error(`[add-pressroom] tenant "${TENANT_SLUG}" not found — nothing to do.`);
    process.exit(1);
  }

  const existing = (
    await pFind(payload, "pillars", { where: { and: [{ tenant: { equals: tenant.id } }, { slug: { equals: PILLAR_SLUG } }] }, limit: 1 })
  ).docs[0] as Record<string, unknown> | undefined;

  if (existing) {
    const id = existing.id as number | string;
    const subsections = await pCount(payload, "subsections", { pillar: { equals: id } });
    const secondaryRefs = await pCount(payload, "articles", { "secondarySections.pillar": { equals: id } });
    if (subsections > 0 || secondaryRefs > 0) {
      console.error(
        `[add-pressroom] REFUSING: the existing ${TENANT_SLUG}/${PILLAR_SLUG} pillar (id ${String(id)}) has ${subsections} sub-section(s) ` +
          `and ${secondaryRefs} secondary-section reference(s), which the single-home rule forbids. Resolve them in /admin first. Nothing changed.`,
      );
      process.exit(1);
    }
    console.log(`[add-pressroom] ${TENANT_SLUG}/${PILLAR_SLUG} already exists (id ${String(id)}, order ${String(existing.order)}). Never overwritten.`);
    const diffs = (Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]).filter((k) => existing[k] !== DEFAULTS[k]);
    if (diffs.length === 0) console.log("[add-pressroom] fields match the defaults.");
    for (const k of diffs) console.log(`  ${k}: current ${JSON.stringify(existing[k] ?? null)}  default ${JSON.stringify(DEFAULTS[k])}`);
    if (APPLY) console.log(`[add-pressroom] result log: ${writeResultLog({ outcome: "exists", tenant: TENANT_SLUG, slug: PILLAR_SLUG, id })}`);
    process.exit(0);
  }

  const top = (await pFind(payload, "pillars", { where: { tenant: { equals: tenant.id } }, sort: "-order", limit: 1 })).docs[0] as
    | { order?: unknown }
    | undefined;
  const order = typeof top?.order === "number" && Number.isFinite(top.order) ? top.order + 1 : FALLBACK_ORDER;
  const data = { tenant: relId(tenant.id), slug: PILLAR_SLUG, order, ...DEFAULTS };

  if (!APPLY) {
    console.log("[add-pressroom] DRY RUN — would create:");
    console.log(JSON.stringify(data, null, 2));
    console.log("[add-pressroom] re-run with --apply to create it.");
    process.exit(0);
  }

  const created = (await pCreate(payload, "pillars", data)) as { id: number | string };
  console.log(`[add-pressroom] created ${TENANT_SLUG}/${PILLAR_SLUG} (id ${String(created.id)}, order ${order}).`);
  console.log(`[add-pressroom] result log: ${writeResultLog({ outcome: "created", tenant: TENANT_SLUG, slug: PILLAR_SLUG, id: created.id })}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[add-pressroom] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
