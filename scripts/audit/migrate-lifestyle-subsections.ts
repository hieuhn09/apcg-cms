/**
 * BriefAsia `lifestyle` taxonomy change — retire the `art` sub-section, introduce
 * `consumer` in its place.
 *
 * Three independent, idempotent subcommands. Each is DRY-RUN by default and
 * writes nothing without `--apply`. Exactly one subcommand per run.
 *
 *   --add-consumer  Create `consumer` under the briefasia `lifestyle` pillar,
 *                   inheriting the `order` value `art` currently holds so the
 *                   tab bar / nav dropdown ordering is unchanged. No-op if it
 *                   already exists.
 *   --check-art     Read-only. Count every article still pointing at `art`,
 *                   both as the primary `subSection` and inside any
 *                   `secondarySections[].subSection` row. This is the gate for
 *                   `--remove-art`.
 *   --remove-art    Delete the `art` sub-section. REFUSES while any article
 *                   still references it — deleting it out from under a live
 *                   article would orphan the reference and mislabel the story
 *                   site-wide.
 *
 * SCOPE — article re-homing is deliberately NOT here.
 * Moving the existing `art` articles to their correct new homes is already
 * handled by the sibling tooling built for the lifestyle/luxury backlog:
 *   1. content-engine repo : `npm run audit:luxury`   → emits a decision JSON
 *   2. this repo           : `npm run audit:apply-luxury -- --in <that json> --apply`
 * Reimplementing that re-homing here would duplicate a reviewed decision path
 * and give two scripts write authority over the same field.
 *
 * INTENDED OPERATOR ORDER
 *   1. npm run audit:migrate-lifestyle -- --add-consumer --apply
 *   2. re-home the `art` articles via audit:luxury → audit:apply-luxury (above)
 *   3. npm run audit:migrate-lifestyle -- --check-art          (expect 0)
 *   4. npm run audit:migrate-lifestyle -- --remove-art --apply
 *
 * The reader site has no sub-section URL segment (routes are `[locale]/[pillar]`
 * and `[locale]/article/[slug]`), so retiring a sub-section breaks no public URL
 * and needs no redirect.
 *
 *   npm run audit:migrate-lifestyle -- --check-art
 *   npm run audit:migrate-lifestyle -- --add-consumer --apply
 *   tsx scripts/audit/migrate-lifestyle-subsections.ts --remove-art --apply
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import { getPayload } from "payload";
import { pCreate, pDelete, pFind } from "../lib/payload-loose";

// `@payload-config` throws at module scope when DATABASE_URL is unset, which
// would pre-empt the CLI guards below and hand the user a credentials error
// instead of the usage text. Imported lazily inside main() so argument
// validation and the dry-run banner always come first.

/** CMS tenant slug for BriefAsia (scripts/seed.ts TENANTS, src/collections/Tenants.ts). */
const TENANT_SLUG = "brief-asia";
const PILLAR_SLUG = "lifestyle";
const OLD_SUB_SLUG = "art";
const NEW_SUB = { slug: "consumer", title: "Consumer" } as const;
/** Only used if `art` is already gone when `--add-consumer` runs; matches the
 *  `order` the seed file gives the row (scripts/seed.ts, lifestyle subsections). */
const FALLBACK_ORDER = 3;

type Subcommand = "add-consumer" | "check-art" | "remove-art";

const SUBCOMMANDS: Record<string, Subcommand> = {
  "--add-consumer": "add-consumer",
  "--check-art": "check-art",
  "--remove-art": "remove-art",
};

const KNOWN_FLAGS = new Set([...Object.keys(SUBCOMMANDS), "--apply"]);

/* ── CLI ─────────────────────────────────────────────────────────────────── */

function usage(message: string): never {
  console.error(`\n${message}\n`);
  console.error(
    "Usage:\n" +
      "  tsx scripts/audit/migrate-lifestyle-subsections.ts <subcommand> [--apply]\n" +
      "\n" +
      "Subcommands (exactly one required):\n" +
      "  --add-consumer  create the `consumer` sub-section under briefasia/lifestyle,\n" +
      "                  reusing the `order` value `art` currently holds\n" +
      "  --check-art     read-only; count articles still referencing `art`\n" +
      "                  (primary subSection + secondarySections[].subSection)\n" +
      "  --remove-art    delete the `art` sub-section; refuses while any article\n" +
      "                  still references it\n" +
      "\n" +
      "  --apply         perform writes. Without it every subcommand is a dry run.\n" +
      "\n" +
      "Article re-homing is NOT done here — use content-engine `audit:luxury`\n" +
      "then this repo's `audit:apply-luxury`.\n",
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");

const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
if (unknown.length > 0) usage(`Unknown argument(s): ${unknown.join(", ")}`);

const chosen = argv.filter((a) => a in SUBCOMMANDS);
if (chosen.length === 0) usage("Refusing to run: a subcommand is required.");
if (chosen.length > 1) usage(`Refusing to run: pass exactly one subcommand (got: ${chosen.join(", ")}).`);
const SUBCOMMAND = SUBCOMMANDS[chosen[0]!]!;

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Relationship fields come back as an id or an expanded doc; normalise to id. */
function relId(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "object" && "id" in (v as Record<string, unknown>)) {
    const id = (v as { id?: unknown }).id;
    if (typeof id === "number" || typeof id === "string") return id;
  }
  return null;
}

interface SubSectionRow {
  id: string | number;
  slug?: string | null;
  title?: string | null;
  order?: number | null;
  pillar?: unknown;
}

interface ArticleRef {
  id: string | number;
  slug: string;
  title: string;
  /** Where the reference lives: the primary field, or a secondary-sections row. */
  via: "subSection" | "secondarySections";
}

interface RunResult {
  outcome: string;
  detail: string;
  before: unknown;
  after: unknown;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main() {
  /* ── Banner ───────────────────────────────────────────────────────────── */
  const writes = SUBCOMMAND !== "check-art";
  console.log("");
  console.log("═".repeat(78));
  if (!writes) {
    console.log("  READ-ONLY — --check-art never writes, with or without --apply");
  } else {
    console.log(APPLY ? "  APPLYING — this run WRITES to the database" : "  DRY RUN — no writes; pass --apply to write");
  }
  console.log("═".repeat(78));
  console.log(`  subcommand : --${SUBCOMMAND}`);
  console.log(`  tenant     : ${TENANT_SLUG}`);
  console.log(`  pillar     : ${PILLAR_SLUG}`);
  console.log(
    `  will do    : ${
      SUBCOMMAND === "add-consumer"
        ? `create sub-section "${NEW_SUB.slug}" (title "${NEW_SUB.title}") at the order "${OLD_SUB_SLUG}" holds`
        : SUBCOMMAND === "check-art"
          ? `count articles referencing sub-section "${OLD_SUB_SLUG}"`
          : `delete sub-section "${OLD_SUB_SLUG}" — only if zero articles reference it`
    }`,
  );
  console.log("═".repeat(78));

  const { default: payloadConfig } = await import("@payload-config");
  const payload = await getPayload({ config: await payloadConfig });

  /* ── Tenant ───────────────────────────────────────────────────────────── */
  const tenantRes = (await pFind(payload, "tenants", {
    where: { slug: { equals: TENANT_SLUG } },
    limit: 1,
  })) as { docs: Array<{ id: string | number; slug?: string }> };
  const tenant = tenantRes.docs[0];
  if (!tenant) {
    const all = (await pFind(payload, "tenants", { limit: 100 })) as { docs: Array<{ slug?: string }> };
    throw new Error(
      `Tenant "${TENANT_SLUG}" not found. Tenants in this database: ${all.docs.map((t) => t.slug ?? "(no slug)").join(", ") || "(none)"}`,
    );
  }
  const tenantId = tenant.id;
  console.log(`\ntenant: ${tenant.slug ?? TENANT_SLUG} (id ${tenantId})`);

  /* ── Pillar ───────────────────────────────────────────────────────────── */
  const pillarRes = (await pFind(payload, "pillars", {
    where: { and: [{ tenant: { equals: tenantId } }, { slug: { equals: PILLAR_SLUG } }] },
    limit: 1,
  })) as { docs: Array<{ id: string | number; slug?: string }> };
  const pillar = pillarRes.docs[0];
  if (!pillar) {
    const all = (await pFind(payload, "pillars", { where: { tenant: { equals: tenantId } }, limit: 200 })) as {
      docs: Array<{ slug?: string }>;
    };
    throw new Error(
      `Pillar "${PILLAR_SLUG}" not found in tenant "${TENANT_SLUG}". Pillars: ${all.docs.map((p) => p.slug ?? "(no slug)").join(", ") || "(none)"}`,
    );
  }
  const pillarId = pillar.id;
  console.log(`pillar: ${pillar.slug ?? PILLAR_SLUG} (id ${pillarId})`);

  /* ── Sub-sections of this pillar ──────────────────────────────────────── */
  // Sub-section slugs are unique per pillar, not per tenant, so both scopes are
  // in the query — a same-named row under another pillar must never be touched.
  const subsRes = (await pFind(payload, "subsections", {
    where: { and: [{ tenant: { equals: tenantId } }, { pillar: { equals: pillarId } }] },
    limit: 500,
  })) as { docs: SubSectionRow[] };
  const subsOfPillar = subsRes.docs.filter((s) => String(relId(s.pillar) ?? pillarId) === String(pillarId));
  const artSub = subsOfPillar.find((s) => s.slug === OLD_SUB_SLUG) ?? null;
  const consumerSub = subsOfPillar.find((s) => s.slug === NEW_SUB.slug) ?? null;
  console.log(
    `sub-sections in pillar: ${subsOfPillar.length} — ` +
      `"${OLD_SUB_SLUG}" ${artSub ? `present (id ${artSub.id}, order ${artSub.order ?? "-"})` : "absent"}, ` +
      `"${NEW_SUB.slug}" ${consumerSub ? `present (id ${consumerSub.id}, order ${consumerSub.order ?? "-"})` : "absent"}\n`,
  );

  /** Every article referencing `art`, primary field and secondary rows alike.
   *  `draft: true` so unpublished/newest versions are counted too — an orphan in
   *  a draft is still an orphan. */
  async function findArtReferences(artId: string | number): Promise<ArticleRef[]> {
    const found = new Map<string, ArticleRef>();

    const primary = (await pFind(payload, "articles", {
      where: { and: [{ tenant: { equals: tenantId } }, { subSection: { equals: artId } }] },
      limit: 1000,
      draft: true,
    })) as { docs: Array<{ id: string | number; slug?: string | null; title?: string | null }> };
    for (const a of primary.docs) {
      found.set(String(a.id), { id: a.id, slug: a.slug ?? "", title: a.title ?? "", via: "subSection" });
    }

    const secondary = (await pFind(payload, "articles", {
      where: { and: [{ tenant: { equals: tenantId } }, { "secondarySections.subSection": { equals: artId } }] },
      limit: 1000,
      draft: true,
    })) as { docs: Array<{ id: string | number; slug?: string | null; title?: string | null }> };
    for (const a of secondary.docs) {
      const key = String(a.id);
      // An article can hold BOTH kinds of reference; report the primary one,
      // which is the harder constraint, and never double-count the article.
      if (!found.has(key)) {
        found.set(key, { id: a.id, slug: a.slug ?? "", title: a.title ?? "", via: "secondarySections" });
      }
    }

    return [...found.values()];
  }

  const result: RunResult = { outcome: "", detail: "", before: null, after: null };

  /* ── --add-consumer ───────────────────────────────────────────────────── */
  if (SUBCOMMAND === "add-consumer") {
    if (consumerSub) {
      result.outcome = "no-op";
      result.detail = `sub-section "${NEW_SUB.slug}" already exists (id ${consumerSub.id}, order ${consumerSub.order ?? "-"}) — nothing to do`;
      result.before = { id: consumerSub.id, slug: consumerSub.slug, title: consumerSub.title, order: consumerSub.order };
      console.log(`no-op: ${result.detail}`);
    } else {
      const order = artSub?.order ?? FALLBACK_ORDER;
      if (!artSub) {
        console.warn(
          `warning: "${OLD_SUB_SLUG}" is already gone, so its order could not be read. ` +
            `Falling back to order ${FALLBACK_ORDER} (the value scripts/seed.ts uses).`,
        );
      }
      const data = { slug: NEW_SUB.slug, title: NEW_SUB.title, pillar: pillarId, order, tenant: tenantId };
      result.before = null;
      if (APPLY) {
        try {
          const created = (await pCreate(payload, "subsections", data)) as { id: string | number };
          result.outcome = "applied";
          result.detail = `created sub-section "${NEW_SUB.slug}" (id ${created.id}) at order ${order}`;
          result.after = { id: created.id, ...data };
          console.log(`applied: ${result.detail}`);
        } catch (e) {
          result.outcome = "failed";
          result.detail = `create failed: ${e instanceof Error ? e.message : String(e)}`;
          console.error(result.detail);
        }
      } else {
        result.outcome = "would-apply";
        result.detail = `would create sub-section "${NEW_SUB.slug}" (title "${NEW_SUB.title}") at order ${order}`;
        result.after = data;
        console.log(`would apply: ${result.detail}`);
      }
    }
  }

  /* ── --check-art / --remove-art ───────────────────────────────────────── */
  if (SUBCOMMAND === "check-art" || SUBCOMMAND === "remove-art") {
    if (!artSub) {
      result.outcome = "no-op";
      result.detail = `sub-section "${OLD_SUB_SLUG}" does not exist in ${TENANT_SLUG}/${PILLAR_SLUG} — already removed`;
      console.log(`no-op: ${result.detail}`);
    } else {
      const refs = await findArtReferences(artSub.id);
      const primaryCount = refs.filter((r) => r.via === "subSection").length;
      const secondaryOnly = refs.filter((r) => r.via === "secondarySections").length;
      result.before = {
        subSection: { id: artSub.id, slug: artSub.slug, title: artSub.title, order: artSub.order },
        referencingArticles: refs.length,
        primaryCount,
        secondaryOnlyCount: secondaryOnly,
      };

      console.log(
        `articles referencing "${OLD_SUB_SLUG}": ${refs.length} ` +
          `(primary subSection: ${primaryCount}, secondary-sections only: ${secondaryOnly})`,
      );
      for (const r of refs) {
        console.log(`  - ${r.slug || "(no slug)"}  [${r.via}]  id=${r.id}  ${r.title}`);
      }

      if (SUBCOMMAND === "check-art") {
        result.outcome = refs.length === 0 ? "clear" : "blocked";
        result.detail =
          refs.length === 0
            ? `no article references "${OLD_SUB_SLUG}" — safe to run --remove-art`
            : `${refs.length} article(s) still reference "${OLD_SUB_SLUG}" — re-home them before --remove-art`;
        console.log(`\n${result.detail}`);
      } else if (refs.length > 0) {
        // The whole point of this subcommand: deleting a sub-section that
        // articles still point at would orphan those references.
        result.outcome = "refused";
        result.detail =
          `REFUSING to delete "${OLD_SUB_SLUG}": ${refs.length} article(s) still reference it. ` +
          `Re-home them first (content-engine audit:luxury → this repo audit:apply-luxury), then re-run --check-art.`;
        console.error(`\n${result.detail}`);
      } else if (APPLY) {
        try {
          await pDelete(payload, "subsections", artSub.id);
          result.outcome = "applied";
          result.detail = `deleted sub-section "${OLD_SUB_SLUG}" (id ${artSub.id})`;
          result.after = null;
          console.log(`\napplied: ${result.detail}`);
        } catch (e) {
          result.outcome = "failed";
          result.detail = `delete failed: ${e instanceof Error ? e.message : String(e)}`;
          console.error(`\n${result.detail}`);
        }
      } else {
        result.outcome = "would-apply";
        result.detail = `would delete sub-section "${OLD_SUB_SLUG}" (id ${artSub.id}) — 0 articles reference it`;
        result.after = null;
        console.log(`\nwould apply: ${result.detail}`);
      }
    }
  }

  /* ── Summary + result log ─────────────────────────────────────────────── */
  console.log("\nsummary");
  console.log(`  subcommand : --${SUBCOMMAND}`);
  console.log(`  outcome    : ${result.outcome}`);
  console.log(`  detail     : ${result.detail}`);

  // Only a run that actually wrote gets a log; --check-art and dry runs change
  // nothing, so there is nothing to reverse.
  if (APPLY && result.outcome === "applied") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = path.resolve(process.cwd(), `migrate-lifestyle-subsections.${SUBCOMMAND}.applied-${stamp}.json`);
    fs.writeFileSync(
      logPath,
      `${JSON.stringify(
        {
          appliedAt: new Date().toISOString(),
          subcommand: SUBCOMMAND,
          tenant: { slug: tenant.slug ?? TENANT_SLUG, id: tenantId },
          pillar: { slug: pillar.slug ?? PILLAR_SLUG, id: pillarId },
          outcome: result.outcome,
          detail: result.detail,
          before: result.before,
          after: result.after,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`\nresult log written: ${logPath}`);
  } else if (writes && !APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to write.");
  }
  console.log("");

  process.exit(result.outcome === "failed" || result.outcome === "refused" ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
