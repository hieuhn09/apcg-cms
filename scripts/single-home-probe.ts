/**
 * single-home-probe.ts — empirical probe for the single-home pillar rule
 * (BriefAsia Pressroom). LOCAL DATABASE ONLY: hard-refuses any non-local
 * DATABASE_URL via scripts/lib/local-db-guard.ts (no override). It creates AND
 * deletes rows.
 *
 *   npm run db:seed                         # tenants + taxonomy (brief-asia, wad, gcv, ...)
 *   npm run probe:single-home               # Local API checks (E1/E1b/E2, scripts path, E-pillar, controls, seed guard)
 *   npm run probe:single-home -- --http     # + live REST/GraphQL checks against a running CMS
 *                                           #   (SINGLE_HOME_PROBE_BASE, default http://127.0.0.1:3511;
 *                                           #    logs in with SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD)
 *
 * Every fixture carries a run tag and is deleted in `finally`. The brief-asia
 * `pressroom` row is reused when it already exists (and then never deleted);
 * otherwise the probe creates it, runs the 0-reference delete check on it last,
 * and leaves none behind. Also creates and deletes `(wad, pressroom)` and
 * `(gcv, pressroom)` rows (+ wad/gcv articles) for the negative controls.
 *
 * Exit code 0 = every check passed.
 */
import "./lib/env";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { assertLocalDb, LocalDbGuardError } from "./lib/local-db-guard";

// Guard FIRST, before the Payload config is even imported.
let banner: string;
try {
  banner = assertLocalDb(process.env.DATABASE_URL).banner;
} catch (err) {
  console.error(err instanceof LocalDbGuardError ? err.message : "local-db guard: refusing.");
  process.exit(2);
}

const V1 = 'pillar rule: "pressroom" is a single-home pillar: an article filed there cannot also have secondary sections.';
const V2 = 'pillar rule: "pressroom" is a single-home pillar: an article filed there cannot have a sub-section.';
const V3 = 'pillar rule: "pressroom" is a single-home pillar: it cannot be added as a secondary section to another article.';
const V4 = 'pillar rule: "pressroom" is a single-home pillar: it cannot have sub-sections.';
const V6 = 'pillar rule: "pressroom" is a single-home pillar: an article filed there cannot be marked exclusive.';
const RENAME = "pillar rule: this pillar's slug cannot be changed.";
const MOVE = "pillar rule: this pillar cannot be moved to another tenant.";
const DELETE = "pillar rule: this pillar cannot be deleted while articles or sub-sections use it.";

type Id = number;
type Doc = Record<string, unknown> & { id: Id };
type Payload = Awaited<ReturnType<typeof import("payload").getPayload>>;

const TAG = `shp-${randomBytes(3).toString("hex")}`;
let failures = 0;
let checks = 0;

function pass(name: string, detail = "") {
  checks += 1;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name: string, detail: string) {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${name} — ${detail}`);
}
function errText(err: unknown): string {
  const data = (err as { data?: { errors?: { message?: string }[] } })?.data;
  const msgs = (data?.errors ?? []).map((e) => e.message).filter(Boolean);
  if (msgs.length) return msgs.join("; ");
  return err instanceof Error ? err.message : String(err);
}

async function expectReject(name: string, fn: () => Promise<unknown>, message?: string | RegExp) {
  try {
    await fn();
    fail(name, "write was ACCEPTED");
  } catch (err) {
    const text = errText(err);
    const ok = message === undefined ? true : typeof message === "string" ? text === message : message.test(text);
    if (ok) pass(name, text);
    else fail(name, `rejected with an unexpected message: ${text}`);
  }
}
async function expectOk<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    pass(name);
    return r;
  } catch (err) {
    fail(name, `rejected: ${errText(err)}`);
    return undefined;
  }
}

// ── cleanup registry (deleted in reverse order) ──
const created: Array<{ collection: string; id: Id }> = [];
const track = (collection: string, doc: { id: Id }) => {
  created.push({ collection, id: doc.id });
  return doc;
};

function rawDb(payload: Payload) {
  return (payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<{ rows?: Record<string, unknown>[] }> } }).drizzle;
}

async function main() {
  const { getPayload } = await import("payload");
  const { sql } = await import("@payloadcms/db-postgres");
  const { default: config } = await import("../payload.config");
  const { pCreate } = await import("./lib/payload-loose");
  console.log(`[probe] database ${banner} — run tag ${TAG}`);
  const payload = await getPayload({ config });
  const db = rawDb(payload);

  const find = async (collection: string, where: Record<string, unknown>) =>
    (await payload.find({ collection: collection as never, where: where as never, limit: 1, depth: 0, overrideAccess: true })).docs[0] as Doc | undefined;
  const create = async (collection: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    track(collection, (await payload.create({ collection: collection as never, data: data as never, overrideAccess: true, depth: 0, ...extra } as never)) as unknown as Doc);
  const update = async (collection: string, id: Id, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    (await payload.update({ collection: collection as never, id, data: data as never, overrideAccess: true, depth: 0, ...extra } as never)) as unknown as Doc;
  const remove = async (collection: string, id: Id) => {
    // Published articles enqueue translation_jobs whose article_id is NOT NULL with
    // ON DELETE SET NULL (pre-existing schema), which makes a plain delete fail.
    if (collection === "articles") await db.execute(sql`DELETE FROM translation_jobs WHERE article_id = ${id}`);
    return payload.delete({ collection: collection as never, id, overrideAccess: true } as never);
  };

  let ownPressroom = false;
  let pressroomId: Id | undefined;
  try {
    const ba = await find("tenants", { slug: { equals: "brief-asia" } });
    const wad = await find("tenants", { slug: { equals: "wad" } });
    const gcv = await find("tenants", { slug: { equals: "gcv" } });
    const dtw = await find("tenants", { slug: { equals: "dtw" } });
    if (!ba || !wad || !gcv || !dtw) throw new Error("tenants brief-asia / wad / gcv / dtw missing — run `npm run db:seed` first");
    const asia = await find("pillars", { and: [{ tenant: { equals: ba.id } }, { slug: { equals: "asia" } }] });
    const finance = await find("pillars", { and: [{ tenant: { equals: ba.id } }, { slug: { equals: "finance" } }] });
    if (!asia || !finance) throw new Error("brief-asia pillars asia/finance missing — run `npm run db:seed` first");

    // ── fixtures ──
    let pressroom = await find("pillars", { and: [{ tenant: { equals: ba.id } }, { slug: { equals: "pressroom" } }] });
    if (!pressroom) {
      pressroom = await create("pillars", { tenant: ba.id, slug: "pressroom", title: "Pressroom", heading: "Pressroom", color: "var(--accent)", icon: "newspaper", order: 9 });
      ownPressroom = true;
      created.pop(); // deleted explicitly by the 0-ref delete check, not by the cleanup loop
    }
    pressroomId = pressroom.id;
    console.log(`[probe] brief-asia pressroom pillar id ${pressroom.id} (${ownPressroom ? "created by probe" : "pre-existing, reused"})`);
    const wadPress = await create("pillars", { tenant: wad.id, slug: "pressroom", title: "WAD Pressroom", order: 99 });
    const gcvPress = await create("pillars", { tenant: gcv.id, slug: "pressroom", title: "GCV Pressroom", order: 99 });
    const asiaSub = await create("subsections", { tenant: ba.id, pillar: asia.id, slug: `${TAG}-sub`, title: "Probe sub" });
    const baAuthor = await create("authors", { tenant: ba.id, name: `${TAG} BA` });
    const wadAuthor = await create("authors", { tenant: wad.id, name: `${TAG} WAD` });
    const gcvAuthor = await create("authors", { tenant: gcv.id, name: `${TAG} GCV` });
    let n = 0;
    const art = (tenant: Id, author: Id, extra: Record<string, unknown>) => ({
      tenant,
      author,
      title: `${TAG} article ${++n}`,
      slug: `${TAG}-a${n}`,
      workflowStatus: "draft",
      ...extra,
    });

    console.log("\n[E1] Local API write paths (create / draft / publish)");
    for (const draft of [false, true]) {
      const d = draft ? " (draft:true)" : "";
      await expectReject(`V1 pressroom + secondary row${d}`, () => create("articles", art(ba.id, baAuthor.id, { pillar: pressroom!.id, secondarySections: [{ pillar: asia.id }] }), { draft }), V1);
      await expectReject(`V2 pressroom + subSection${d}`, () => create("articles", art(ba.id, baAuthor.id, { pillar: pressroom!.id, subSection: asiaSub.id }), { draft }), V2);
      await expectReject(`V3 asia + secondary pressroom${d}`, () => create("articles", art(ba.id, baAuthor.id, { pillar: asia.id, secondarySections: [{ pillar: pressroom!.id }] }), { draft }), V3);
      await expectReject(`V3 null primary + secondary pressroom${d}`, () => create("articles", art(ba.id, baAuthor.id, { secondarySections: [{ pillar: pressroom!.id }] }), { draft: true }), V3);
      await expectReject(`V6 pressroom + exclusive${d}`, () => create("articles", art(ba.id, baAuthor.id, { pillar: pressroom!.id, exclusive: true }), { draft }), V6);
      await expectReject(`V1 persisted duplicate-of-primary row${d}`, () => create("articles", art(ba.id, baAuthor.id, { pillar: pressroom!.id, secondarySections: [{ pillar: pressroom!.id }] }), { draft }), V1);
    }
    const pArt = await expectOk("valid pressroom-only article (publish)", () =>
      create("articles", art(ba.id, baAuthor.id, { pillar: pressroom!.id, workflowStatus: "published", _status: "published" })),
    );
    const aArt = await expectOk("ordinary asia article with a finance secondary row", () =>
      create("articles", art(ba.id, baAuthor.id, { pillar: asia.id, subSection: asiaSub.id, secondarySections: [{ pillar: finance.id }], workflowStatus: "published", _status: "published" })),
    );

    console.log("\n[AUTHOR] author optional only for single-home");
    const noAuthor = await expectOk("pressroom article with NO author publishes", () =>
      create("articles", art(ba.id, null as unknown as Id, { pillar: pressroom!.id, workflowStatus: "published", _status: "published" })),
    );
    if (noAuthor) {
      // Remove now so the later 0-reference pressroom delete/move checks stay valid.
      await remove("articles", noAuthor.id);
      created.splice(created.findIndex((c) => c.collection === "articles" && c.id === noAuthor.id), 1);
    }
    await expectReject("ordinary asia article with NO author is rejected on publish", () =>
      create("articles", art(ba.id, null as unknown as Id, { pillar: asia.id, workflowStatus: "published", _status: "published" })),
      "This field is required.",
    );
    if (pArt) {
      await expectReject("update pressroom article: partial {secondarySections} (draft)", () => update("articles", pArt.id, { secondarySections: [{ pillar: asia.id }] }, { draft: true }), V1);
      await expectReject("update pressroom article: partial {secondarySections} (publish)", () => update("articles", pArt.id, { secondarySections: [{ pillar: asia.id }] }), V1);
      await expectReject("update pressroom article: {subSection} (draft)", () => update("articles", pArt.id, { subSection: asiaSub.id }, { draft: true }), V2);
      await expectReject("update pressroom article: {exclusive:true} (V6 flip)", () => update("articles", pArt.id, { exclusive: true }), V6);
      await expectOk("status-only update of the pressroom article passes", () => update("articles", pArt.id, { workflowStatus: "hidden" }));
      await expectOk("PATCH secondarySections: [] on the pressroom article passes", () => update("articles", pArt.id, { secondarySections: [] }));
      await expectOk("E2: populated-object pillar (unchanged) passes", () => update("articles", pArt.id, { pillar: { id: pressroom!.id }, workflowStatus: "published" }));
      for (const [label, value] of [["{$push: obj}", { $push: { pillar: asia.id } }], ["{$push: [..]}", { $push: [{ pillar: asia.id }] }]] as const) {
        for (const draft of [false, true]) {
          await expectReject(`G80 ${label} on update${draft ? " (draft)" : ""}`, () => update("articles", pArt.id, { secondarySections: value }, { draft }), /^pillar rule: malformed taxonomy input/);
        }
      }
    }
    for (const [label, value] of [["{$push: obj}", { $push: { pillar: asia.id } }], ["{$push: [..]}", { $push: [{ pillar: asia.id }] }]] as const) {
      for (const draft of [false, true]) {
        await expectReject(`G80 ${label} on create${draft ? " (draft)" : ""}`, () => create("articles", art(ba.id, baAuthor.id, { pillar: asia.id, secondarySections: value }), { draft }), /^pillar rule: malformed taxonomy input/);
      }
    }
    if (aArt) {
      await expectReject("update asia article: add secondary pressroom (publish)", () => update("articles", aArt.id, { secondarySections: [{ pillar: finance.id }, { pillar: pressroom!.id }] }), V3);
      await expectReject("update asia article: primary -> pressroom with stored sub-section (effective state)", () => update("articles", aArt.id, { pillar: pressroom!.id }, { draft: true }), V1);
      await expectOk("status-only update of the asia article passes", () => update("articles", aArt.id, { workflowStatus: "hidden" }));
    }

    console.log("\n[E1b] main doc vs latest draft version");
    if (aArt) {
      await expectOk("draft save on the asia article (title only)", () => update("articles", aArt.id, { title: `${TAG} draft title` }, { draft: true }));
      await expectReject("draft save adding a secondary pressroom row after a draft exists", () => update("articles", aArt.id, { secondarySections: [{ pillar: pressroom!.id }] }, { draft: true }), V3);
      await expectReject("publish moving primary to pressroom with a stored exclusive flag", async () => {
        await db.execute(sql`UPDATE articles SET exclusive = true WHERE id = ${aArt.id}`);
        await db.execute(sql`UPDATE _articles_v SET version_exclusive = true WHERE parent_id = ${aArt.id} AND latest = true`);
        return update("articles", aArt.id, { pillar: pressroom!.id, subSection: null, secondarySections: [] });
      }, V6);
    }

    console.log("\n[G54/G94] a pre-existing violating article stays hideable / republishable");
    const legacy = await expectOk("legacy article created clean (asia)", () =>
      create("articles", art(ba.id, baAuthor.id, { pillar: asia.id, workflowStatus: "published", _status: "published" })),
    );
    if (legacy) {
      // Inject a violation the hook would refuse (raw SQL = the documented residual), in the main
      // table AND the latest version row, so originalDoc carries it whichever source Payload reads.
      const rowId = `${TAG}-legacy-row`;
      await db.execute(sql`INSERT INTO articles_secondary_sections (_order, _parent_id, id, pillar_id) VALUES (1, ${legacy.id}, ${rowId}, ${pressroom.id})`);
      await db.execute(
        sql`INSERT INTO _articles_v_version_secondary_sections (_order, _parent_id, pillar_id, _uuid) SELECT 1, v.id, ${pressroom.id}, ${rowId} FROM _articles_v v WHERE v.parent_id = ${legacy.id} AND v.latest = true`,
      );
      await expectOk("hide (status-only, publish path) the legacy violating article", () => update("articles", legacy.id, { workflowStatus: "hidden" }));
      await expectOk("republish the legacy violating article", () => update("articles", legacy.id, { workflowStatus: "published", _status: "published" }));
      await expectReject("changing the legacy article's taxonomy is evaluated (V3)", () => update("articles", legacy.id, { subSection: asiaSub.id }), V3);
    }

    console.log("\n[scripts path] payload-loose pCreate");
    await expectReject("pCreate pressroom + secondary row", () => pCreate(payload, "articles", art(ba.id, baAuthor.id, { pillar: pressroom!.id, secondarySections: [{ pillar: asia.id }] })), V1);

    console.log("\n[V4] SubSections");
    await expectReject("sub-section under the brief-asia pressroom pillar", () => create("subsections", { tenant: ba.id, pillar: pressroom!.id, slug: `${TAG}-press-sub`, title: "x" }), V4);
    await expectOk("sub-section under WAD's pressroom pillar (control)", () => create("subsections", { tenant: wad.id, pillar: wadPress.id, slug: `${TAG}-wad-sub`, title: "x" }));

    console.log("\n[controls] wad / gcv pressroom are not single-home");
    await expectOk("wad article primary=wad pressroom with a secondary row + exclusive", () =>
      create("articles", art(wad.id, wadAuthor.id, { pillar: wadPress.id, secondarySections: [{ pillar: wadPress.id }], exclusive: true })),
    );
    const gcvOther = await find("pillars", { and: [{ tenant: { equals: gcv.id } }, { slug: { not_equals: "pressroom" } }] });
    await expectOk("gcv article with a secondary gcv pressroom row", () =>
      create("articles", art(gcv.id, gcvAuthor.id, { pillar: gcvOther?.id ?? gcvPress.id, secondarySections: [{ pillar: gcvPress.id }] })),
    );

    console.log("\n[E-pillar] Pillars row guards");
    await expectReject("rename brief-asia pressroom slug", () => update("pillars", pressroom!.id, { slug: "press" }), RENAME);
    await expectReject("rename brief-asia pressroom slug by case/whitespace", () => update("pillars", pressroom!.id, { slug: "Pressroom " }), RENAME);
    // dtw has no `pressroom` pillar, so slug uniqueness cannot pre-empt the guard.
    await expectReject("move brief-asia pressroom to another tenant (dtw, PATCH {tenant})", () => update("pillars", pressroom!.id, { tenant: dtw.id }), MOVE);
    await expectOk("update brief-asia pressroom title (pair unchanged)", () => update("pillars", pressroom!.id, { title: "Pressroom" }));
    await expectOk("rename WAD's pressroom (control) and back", async () => {
      await update("pillars", wadPress.id, { slug: `${TAG}-wadpress` });
      return update("pillars", wadPress.id, { slug: "pressroom" });
    });

    const tryDelete = (label: string) => expectReject(`delete in-use pressroom: ${label}`, () => remove("pillars", pressroom!.id), DELETE);
    if (pArt) await tryDelete("referenced by a main article");
    if (ownPressroom) {
      // Isolate each reference kind: remove the main-article reference first.
      if (pArt) {
        await remove("articles", pArt.id);
        created.splice(created.findIndex((c) => c.collection === "articles" && c.id === pArt.id), 1);
      }
      if (legacy) {
        await remove("articles", legacy.id); // carries a raw secondary pressroom row
        created.splice(created.findIndex((c) => c.collection === "articles" && c.id === legacy.id), 1);
      }
      if (aArt) {
        await remove("articles", aArt.id); // its draft version may reference pressroom
        created.splice(created.findIndex((c) => c.collection === "articles" && c.id === aArt.id), 1);
      }
      const nl = await create("newsletters", { tenant: ba.id, name: `${TAG} NL`, slug: `${TAG}-nl`, vertical: pressroom.id });
      await tryDelete("referenced only by a newsletter vertical");
      await remove("newsletters", nl.id);
      created.pop();

      const sec = await create("articles", art(ba.id, baAuthor.id, { pillar: asia.id, workflowStatus: "published", _status: "published" }));
      await db.execute(sql`INSERT INTO articles_secondary_sections (_order, _parent_id, id, pillar_id) VALUES (1, ${sec.id}, ${`${TAG}-sec-row`}, ${pressroom.id})`);
      await tryDelete("referenced only by a secondary row");
      await remove("articles", sec.id);
      created.pop();

      const rawSub = await db.execute(
        sql`INSERT INTO subsections (tenant_id, slug, pillar_id, "order") VALUES (${ba.id}, ${`${TAG}-raw-sub`}, ${pressroom.id}, 0) RETURNING id`,
      );
      await tryDelete("referenced only by a sub-section");
      await db.execute(sql`DELETE FROM subsections WHERE id = ${rawSub.rows?.[0]?.id as number}`);

      const dv = await create("articles", art(ba.id, baAuthor.id, { pillar: asia.id, workflowStatus: "published", _status: "published" }));
      await update("articles", dv.id, { pillar: pressroom.id }, { draft: true });
      const main = (await payload.findByID({ collection: "articles", id: dv.id, depth: 0, overrideAccess: true } as never)) as unknown as Doc;
      if (main.pillar !== asia.id) fail("draft-only fixture", `main doc pillar is ${String(main.pillar)}, expected asia`);
      await tryDelete("referenced only by a draft version");
      await remove("articles", dv.id);
      created.pop();

      await expectOk("delete of the 0-reference pressroom row is allowed", () => remove("pillars", pressroom!.id));
      pressroomId = undefined;
      // With no brief-asia pressroom row left, uniqueness cannot pre-empt the guard.
      await expectReject("move WAD's pressroom into brief-asia (PATCH {tenant})", () => update("pillars", wadPress.id, { tenant: ba.id }), MOVE);
    } else {
      console.log("  SKIP  per-reference delete checks, 0-ref delete and the WAD->brief-asia move — the brief-asia pressroom row pre-existed (run on a fresh seed to cover them)");
    }

    console.log("\n[G87] seed fixture guard");
    const seed = spawnSync("npx", ["tsx", "scripts/seed.ts"], {
      env: { ...process.env, SEED_INCLUDE_PRESSROOM: "true", DATABASE_URL: "postgres://u:p@db.example.com:5432/x", PAYLOAD_DB_PUSH: "false" },
      encoding: "utf8",
      timeout: 120_000,
    });
    const seedOut = `${seed.stdout}${seed.stderr}`;
    if (seed.status !== 0 && /local-db guard/.test(seedOut) && !/\[seed\] created|\[seed\] countries/.test(seedOut)) {
      pass("seed with SEED_INCLUDE_PRESSROOM=true + non-local DATABASE_URL exits before any write", `exit ${seed.status}`);
    } else {
      fail("seed guard", `exit ${seed.status}; output: ${seedOut.slice(0, 300)}`);
    }

    if (process.argv.includes("--http")) await httpChecks({ baId: ba.id, asiaId: asia.id, asiaSubId: asiaSub.id, authorId: baAuthor.id, create, update, sql, db });
  } finally {
    for (const c of created.reverse()) {
      try {
        await remove(c.collection, c.id);
      } catch (err) {
        console.log(`  (cleanup) could not delete ${c.collection} ${c.id}: ${errText(err)}`);
      }
    }
    if (ownPressroom && pressroomId !== undefined) {
      try {
        await remove("pillars", pressroomId);
      } catch (err) {
        console.log(`  (cleanup) could not delete the probe pressroom row: ${errText(err)}`);
      }
    }
  }

  console.log(`\n[probe] ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── live REST / GraphQL (Env-L CMS server) ──────────────────────────────────
async function httpChecks(ctx: {
  baId: Id;
  asiaId: Id;
  asiaSubId: Id;
  authorId: Id;
  create: (c: string, d: Record<string, unknown>, e?: Record<string, unknown>) => Promise<Doc>;
  update: (c: string, id: Id, d: Record<string, unknown>, e?: Record<string, unknown>) => Promise<Doc>;
  sql: typeof import("@payloadcms/db-postgres").sql;
  db: ReturnType<typeof rawDb>;
}) {
  const base = process.env.SINGLE_HOME_PROBE_BASE ?? "http://127.0.0.1:3511";
  console.log(`\n[HTTP] REST + GraphQL against ${base}`);
  const login = await fetch(`${base}/api/users/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD }),
  });
  const token = ((await login.json()) as { token?: string }).token;
  if (!login.ok || !token) {
    fail("admin login", `HTTP ${login.status}`);
    return;
  }
  const auth = { "content-type": "application/json", authorization: `JWT ${token}` };
  const { baId, asiaId, asiaSubId, authorId, create, sql, db } = ctx;

  // The single-home row must exist for the HTTP checks.
  const pr = (await (await fetch(`${base}/api/pillars?where[slug][equals]=pressroom&where[tenant][equals]=${baId}&depth=0`, { headers: auth })).json()) as { docs: Doc[] };
  let pressroomId = pr.docs[0]?.id;
  let ownRow = false;
  if (pressroomId === undefined) {
    const doc = await create("pillars", { tenant: baId, slug: "pressroom", title: "Pressroom", order: 9 });
    pressroomId = doc.id;
    ownRow = true;
  }

  const restReject = async (name: string, url: string, body: unknown, expect: RegExp) => {
    const r = await fetch(url, { method: "PATCH", headers: auth, body: JSON.stringify(body) });
    const text = await r.text();
    if (r.status >= 400 && expect.test(text)) pass(name, `HTTP ${r.status}`);
    else fail(name, `HTTP ${r.status}: ${text.slice(0, 200)}`);
  };

  const pArt = await create("articles", { tenant: baId, author: authorId, title: `${TAG} http press`, slug: `${TAG}-http-p`, pillar: pressroomId, workflowStatus: "draft" });
  const aArt = await create("articles", { tenant: baId, author: authorId, title: `${TAG} http asia`, slug: `${TAG}-http-a`, pillar: asiaId, subSection: asiaSubId, workflowStatus: "draft" });
  for (const q of ["", "?draft=true"]) {
    await restReject(`REST PATCH {$push: obj}${q}`, `${base}/api/articles/${pArt.id}${q}`, { secondarySections: { $push: { pillar: asiaId } } }, /pillar rule: malformed taxonomy input/);
    await restReject(`REST PATCH {$push: [..]}${q}`, `${base}/api/articles/${aArt.id}${q}`, { secondarySections: { $push: [{ pillar: pressroomId }] } }, /pillar rule: malformed taxonomy input/);
    await restReject(`REST PATCH secondary pressroom row${q}`, `${base}/api/articles/${aArt.id}${q}`, { secondarySections: [{ pillar: pressroomId }] }, /cannot be added as a secondary section/);
    await restReject(`REST PATCH pressroom + subSection${q}`, `${base}/api/articles/${pArt.id}${q}`, { subSection: asiaSubId }, /cannot have a sub-section/);
  }

  // G85: GraphQL restoreVersion + update in ONE request share req.context
  // (isRestoringVersion suppresses Payload's backfill of absent keys).
  for (const exclusive of [false, true]) {
    const x = await create("articles", { tenant: baId, author: authorId, title: `${TAG} gql x${exclusive ? " excl" : ""}`, slug: `${TAG}-gql-x${exclusive ? "e" : ""}`, pillar: asiaId, subSection: exclusive ? null : asiaSubId, exclusive, workflowStatus: "draft" });
    const y = await create("articles", { tenant: baId, author: authorId, title: `${TAG} gql y${exclusive ? "e" : ""}`, slug: `${TAG}-gql-y${exclusive ? "e" : ""}`, pillar: asiaId, workflowStatus: "draft" });
    await ctx.update("articles", y.id, { title: `${TAG} gql y v2${exclusive ? "e" : ""}` });
    const versions = (await (await fetch(`${base}/api/articles/versions?where[parent][equals]=${y.id}&depth=0&limit=5`, { headers: auth })).json()) as { docs: { id: Id }[] };
    const v = versions.docs[versions.docs.length - 1]?.id;
    if (v === undefined) {
      fail(`GraphQL restoreVersion+update${exclusive ? " (exclusive variant)" : ""}`, "no version of fixture Y");
      continue;
    }
    const query = `mutation { r: restoreVersionArticle(id: ${v}) { id } u: updateArticle(id: ${x.id}, data: { title: "${TAG} gql hijack", tenant: ${baId}, pillar: ${pressroomId} }) { id } }`;
    const res = await fetch(`${base}/api/graphql`, { method: "POST", headers: auth, body: JSON.stringify({ query }) });
    const body = (await res.json()) as { data?: { r?: unknown; u?: unknown }; errors?: { message?: string; path?: string[]; extensions?: unknown }[] };
    const uErr = (body.errors ?? []).find((e) => (e.path ?? []).includes("u"));
    const row = (
      await db.execute(sql`SELECT pillar_id, sub_section_id, exclusive FROM articles WHERE id = ${x.id}`)
    ).rows?.[0] as { pillar_id: number; sub_section_id: number | null; exclusive: boolean } | undefined;
    const unchanged = row !== undefined && row.pillar_id === asiaId && (exclusive ? row.exclusive === true : row.sub_section_id === asiaSubId);
    const name = `GraphQL restoreVersion+update rejected, X unchanged${exclusive ? " (exclusive:true variant)" : " (sub-section variant)"}`;
    // `r` must have SUCCEEDED: only then is req.context.isRestoringVersion set for `u` (G85).
    if (body.data?.r && uErr && !body.data?.u && unchanged) pass(name, `${uErr.message ?? ""} ${JSON.stringify(uErr.extensions ?? {}).slice(0, 160)}`);
    else fail(name, `errors=${JSON.stringify(body.errors ?? []).slice(0, 300)} data.r=${JSON.stringify(body.data?.r)} data.u=${JSON.stringify(body.data?.u)} row=${JSON.stringify(row)}`);
  }

  if (ownRow) {
    // Leave no pressroom row behind; articles referencing it are deleted by the main cleanup first.
    created.push({ collection: "pillars", id: pressroomId });
    created.unshift(created.pop()!);
  }
}

main().catch((err) => {
  console.error("[probe] crashed:", errText(err));
  process.exit(1);
});
