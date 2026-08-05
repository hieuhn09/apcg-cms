/**
 * Fill `authors.slug` for a tenant whose authors were imported without one.
 *
 *   AUTHOR_SLUG_TENANT=brief-asia npm run migrate:author-slugs -- [--dry-run]
 *
 * WHY THIS EXISTS
 *
 * brief-asia's own Authors collection has NO slug column — its `/author/[slug]`
 * routes derive the slug from the author's name at request time (src/lib/author.ts).
 * The importer keys authors by `name` and copies no slug, so every brief-asia row
 * lands in Central with `slug` NULL. Central's public `/api/public/articles?author=`
 * resolves by slug, so without this backfill EVERY byline page returns an empty
 * envelope — a silent, indexed regression that renders as "No published stories
 * yet." rather than an error. dtw is in the same position; WTB already carries
 * slugs and is left alone.
 *
 * The slug function below is a CHARACTER-FOR-CHARACTER port of brief-asia's
 * `authorSlug()`. That is the contract: the URLs are already live and indexed, so
 * anything but an exact match silently 404s real traffic. If BA's helper ever
 * changes, this must change with it.
 *
 * Safety:
 *  - only writes rows whose slug is null/empty — never overwrites an existing one;
 *  - collisions (two authors, same derived slug) get a -2, -3 … suffix, and every
 *    one is printed, because a collision means two byline pages were sharing a URL
 *    on the source site too and someone should look;
 *  - re-running is a no-op: filled rows are skipped.
 */
import "../lib/env";
import { DRY_RUN } from "../lib/env";
import { getPayload } from "payload";
import config from "@payload-config";
import { pFind, pUpdate } from "../lib/payload-loose";

const TENANT_SLUG = process.env.AUTHOR_SLUG_TENANT || "brief-asia";

/**
 * Port of brief-asia/src/lib/author.ts `authorSlug()`. Keep in sync.
 * NFD + strip combining marks handles Vietnamese diacritics; đ/Đ has no combining
 * form so it needs its own rule.
 */
function authorSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface AuthorRow {
  id: number | string;
  name?: string | null;
  slug?: string | null;
}

async function main(): Promise<void> {
  const payload = await getPayload({ config });

  const t = (await pFind(payload, "tenants", {
    where: { slug: { equals: TENANT_SLUG } },
    limit: 1,
  })) as unknown as { docs: { id: number | string }[] };
  const tenantId = t.docs[0]?.id;
  if (tenantId == null) throw new Error(`Tenant not found: ${TENANT_SLUG}`);

  const res = (await pFind(payload, "authors", {
    where: { tenant: { equals: tenantId } },
    limit: 1000,
  })) as unknown as { docs: AuthorRow[] };
  const rows = res.docs;

  // Existing slugs in this tenant are reserved — the collision suffix must not
  // land on one, and rows that already have a slug are never touched.
  const taken = new Set(rows.map((r) => (r.slug || "").trim()).filter(Boolean));
  const needed = rows.filter((r) => !(r.slug || "").trim());

  console.log(
    `tenant ${TENANT_SLUG}: ${rows.length} authors, ${rows.length - needed.length} already slugged, ${needed.length} to fill${DRY_RUN ? " (dry run)" : ""}`,
  );

  let filled = 0;
  const collisions: string[] = [];
  const skipped: string[] = [];

  for (const row of needed) {
    const name = (row.name || "").trim();
    const base = name ? authorSlug(name) : "";
    if (!base) {
      // A name that slugifies to nothing (empty, or punctuation only) cannot get
      // a stable URL — leave it null and say so rather than invent one.
      skipped.push(`#${row.id} ${JSON.stringify(row.name)} → empty slug`);
      continue;
    }

    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
    if (slug !== base) collisions.push(`${name}: ${base} taken → ${slug}`);
    taken.add(slug);

    console.log(`  ${DRY_RUN ? "would set" : "set"} #${row.id} ${name} → ${slug}`);
    if (!DRY_RUN) await pUpdate(payload, "authors", row.id, { slug });
    filled += 1;
  }

  if (collisions.length) {
    console.log(`\ncollisions (${collisions.length}) — two authors shared a derived URL on the source site:`);
    for (const c of collisions) console.log(`  ${c}`);
  }
  if (skipped.length) {
    console.log(`\nskipped (${skipped.length}) — no usable slug, byline page will stay empty:`);
    for (const s of skipped) console.log(`  ${s}`);
  }

  console.log(`\n${DRY_RUN ? "would fill" : "filled"} ${filled} author slug(s) for ${TENANT_SLUG}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
