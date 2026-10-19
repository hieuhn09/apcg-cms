/**
 * Implementation of `scripts/migrate/import-gtp-legacy.ts` (loaded through the
 * load guard, see ./load-guard.ts).
 *
 * Mapping-driven importer: legacy GTP (shared network DB, site-filtered) ->
 * Central CMS tenant `gtp` through the Payload Local API (gtp-launch P4, 7.2
 * as superseded by A9-A13). INERT until Phase 5; rehearsed on the synthetic
 * fixture only.
 *
 *   LEGACY_GTP_DB_URL=... DATABASE_URL=... PAYLOAD_SECRET=... \
 *   npm run migrate:gtp:import -- --mapping-overlay <overlay.json> [--mapping <structural.json>]
 *     [--apply] [--entity articles|events|all] [--limit N] [--ids <uuid,..>] [--status published]
 *     [--since YYYY-MM-DD] [--resume] [--run-id X] [--batch 25] [--stop-after-failures 25]
 *     [--from-snapshot dir] [--snapshot-dir dir] [--confirm-host=<host>] [--require-final] [--rehearsal] [--out dir]
 *
 * Safety (all enforced in code):
 *   - DRY RUN unless --apply (lib/args.ts); --apply with --dry-run = exit 2;
 *   - the local-DB guard runs in EVERY mode; a non-local Central needs
 *     --confirm-host (and a TTY for --apply); --require-final is IMPLIED there;
 *   - every legacy query is a closed, site-filtered builder on an allow-listed
 *     table (lib/legacy-sql.ts); only the gtp site row is accepted;
 *   - never updates or deletes existing documents; adopts an existing article
 *     only when it carries the import marker (origin=import,
 *     engineSourceName=legacy:globaltravelpost) in tenant gtp, else
 *     `slugConflictForeign`; every lookup carries the tenant (Countries excepted);
 *   - never creates authors, tenants or pillars; creates tags by slug (tenant);
 *   - fsynced per-article journal `slug-map.ndjson` and pending media entries.
 */
import "../../lib/env";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { getPayload } from "payload";
import { editorConfigFactory } from "@payloadcms/richtext-lexical";
import config from "../../../payload.config";
import { pCreate, pFind } from "../../lib/payload-loose";
import { CliError, intFlag } from "./args";
import { parseCommand, resolveEntity, resolveRequireFinal, resolveTestHooks } from "./cli-spec";
import { profile } from "./network-profile";
import { assignByRule, bodyImageUrls } from "./network-authors";
import { assertImportTenant, centralTarget, loadEffectiveMapping, openLegacy, outDir, resolvePath, runMain } from "./cli-common";
import { assignAuthors, authorTotals, pillarsUnderTwoAuthors, type AuthorItem } from "./gtp-author-distribution";
import { eventBriefs, eventDek, eventStatus, planEvents, toLegacyEvent, type CalendarRef } from "./gtp-events";
import { formatProvisional, mappingFingerprint, type Mapping } from "./gtp-mapping";
import { generateTimestampsFix } from "./gtp-timestamps";
import {
  enText, formatTag, isoOrNull, legacyTags, mapStatus, provenanceRow, publishedAtFor, readMinFor, resolveCountries,
  resolveTaxonomy, sectionsToHtml, statusWrite, str, stripPhotoLabel, takeawaysText, stableFilename, storedFilenameMatches, oldArticleUrl, wordCount, canonicalSourceUrl,
  type CountryRef, type TagRef,
} from "./gtp-transform";
import { FailureControls } from "./failure-controls";
import { htmlToLexical } from "./lexical-body";
import { LiveLegacyReader, writeSnapshot } from "./legacy-reader";
import { effectiveAllowList } from "./legacy-sql";
import { fetchImageWithRetry } from "./media-fetch";
import { normaliseKey } from "./normalise-path";
import { assertOutDirSafe, writeFileSafe } from "./out-dir";
import { RunDir, RunDirError, RUN_MESSAGES, allRunDirs, checkRunId, type MediaMapEntry, type RunState, type SlugMapEntry } from "./run-dir";
import { buildSlugPlan, pinPriorSlugs, planEventSlugs, type SlugPlanEntry } from "./slug-plan";

type Doc = Record<string, unknown>;
type P = Awaited<ReturnType<typeof getPayload>>;

export const MARKER = { origin: "import", engineSourceName: profile().markerSourceName } as const;
const STRUCTURAL_MAPPING_PATH = profile().mappingPath;
const FIXTURE_SITE_ID = profile().fixtureSiteId;
const SINGLE_HOME = new Set<string>(profile().singleHomePillars);
const ctx = { disableRevalidate: true, skipTranslationEnqueue: true };

const ARTICLE_COLUMNS = [
  "id", "slug", "title", "excerpt", "kicker", "body_sections", "status", "section", "subsection", "tags", "format", "featured", "is_hero",
  "read_minutes", "featured_image", "featured_image_credit", "seo", "source_url", "byline", "takeaways", "countries", "published_at",
  "created_at", "updated_at", "migrate_source", "ai_model", "ai_score", "editor_hold", "citations", "label", "region", "category",
];

function newReport() {
  return {
    mode: "dry-run" as "dry-run" | "apply",
    runId: "",
    seen: 0,
    planned: 0,
    imported: 0,
    importedByStatus: {} as Record<string, number>,
    skippedExisting: 0,
    baselineReconstructed: 0,
    ownedByOtherRun: 0,
    orphanUnknown: [] as string[],
    slugConflictForeign: [] as string[],
    rejects: {} as Record<string, number>,
    failed: [] as string[],
    perPillar: {} as Record<string, number>,
    perSub: {} as Record<string, number>,
    rehomed: 0,
    slugChanged: [] as { legacyId: string; from: string; to: string; reason: string }[],
    duplicates: 0,
    heroMissing: 0,
    mediaCreated: 0,
    mediaAdopted: 0,
    mediaFailed: {} as Record<string, number>,
    tagsCreated: [] as string[],
    formatTagSkipped: 0,
    countriesUnmatched: {} as Record<string, number>,
    /** Amendment 3: bylines distributed over the 5-author pool (plan totals are over the COMPLETE planned set). */
    authors: {
      planTotals: {} as Record<string, number>, planSpread: 0, pillarsUnderTwoAuthors: [] as string[], assignedThisRun: {} as Record<string, number>,
      /** Amendment 5: import-marker rows already in Central; how many planned items kept their Central author; totals over (existing + new). */
      existingInCentral: 0, fixedFromCentral: 0, actualTotals: {} as Record<string, number>, actualSpread: 0,
    },
    readMinComputed: 0,
    publishedAtFellBack: 0,
    seoDropped: 0,
    featuredFlag: 0,
    isHeroFlag: 0,
    droppedSections: 0,
    bodyImagesDropped: 0,
    bodyImageUsedAsHero: 0,
    authorSectionFallbacks: 0,
    tagLikeTextRows: 0,
    sourceUrlCollisions: [] as { source_url: string; legacyIds: string[] }[],
    internalLinkRewritable: 0,
    events: { seen: 0, imported: 0, duplicatesSkipped: [] as string[], nearListed: [] as { id: string; of: string; similarity: number }[], archived: 0, publishedAtFromDateStart: 0 },
    e8: { createVsReadbackEqual: 0, createVsReadbackDiffer: 0 },
    timestamps: { blocks: 0, slugNotSqlSafe: 0, timestampsNoSource: 0 },
    stop: null as string | null,
    durationMs: 0,
  };
}
type Report = ReturnType<typeof newReport>;
const bump = (m: Record<string, number>, k: string, by = 1) => (m[k] = (m[k] ?? 0) + by);

async function findOne(payload: P, collection: string, where: Doc, draft = false): Promise<Doc | undefined> {
  const r = (await pFind(payload, collection, { where, limit: 1, ...(draft ? { draft: true } : {}) })) as unknown as { docs: Doc[] };
  return r.docs[0];
}

async function findAll(payload: P, collection: string, where: Doc, extra: Doc = {}): Promise<Doc[]> {
  const out: Doc[] = [];
  for (let page = 1; ; page++) {
    const r = (await pFind(payload, collection, { where, limit: 500, page, ...extra })) as unknown as { docs: Doc[]; hasNextPage?: boolean };
    out.push(...r.docs);
    if (!r.hasNextPage) return out;
  }
}

function relId(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object") return String((v as Doc).id);
  return String(v);
}

function isMarker(doc: Doc): boolean {
  return doc.origin === MARKER.origin && doc.engineSourceName === MARKER.engineSourceName;
}

function isConnectionError(err: unknown): boolean {
  const m = String((err as Error)?.message ?? "");
  return /ECONNRESET|ECONNREFUSED|terminat|Connection|socket hang up|57P01/i.test(m);
}

async function main(): Promise<number> {
  const started = Date.now();
  const a = parseCommand("import", process.argv.slice(2));
  const report = newReport();
  report.mode = a.apply ? "apply" : "dry-run";
  const entity = resolveEntity(a);
  const tenantSlug = assertImportTenant();
  const central = centralTarget(a, a.apply);
  if (!a.get("mapping-overlay")) throw new CliError("import: --mapping-overlay is required (it carries the site filter and the image host).");
  const v0 = loadEffectiveMapping(a, STRUCTURAL_MAPPING_PATH, { structuralOnly: false });
  const siteId = v0.mapping.source.siteFilter as string;
  const rf = resolveRequireFinal("import", a, { centralLocal: central.local, siteFilter: siteId });
  const v = rf.requireFinal ? loadEffectiveMapping(a, STRUCTURAL_MAPPING_PATH, { structuralOnly: false, requireFinal: true }) : v0;
  if (a.has("rehearsal")) console.log(`[import] REHEARSAL (fixture site ${siteId === FIXTURE_SITE_ID ? "yes" : "no"}, local Central ${central.local})`);
  console.log(formatProvisional(v.provisional));
  const m: Mapping = v.mapping;
  const hooks = resolveTestHooks(process.env, central.local);
  const batch = intFlag(a, "batch", 25) as number;
  const limit = intFlag(a, "limit");
  const stopAfter = intFlag(a, "stop-after-failures", 25) as number;
  const idsFilter = a.get("ids") ? new Set((a.get("ids") as string).split(",").map((s) => s.trim().toLowerCase())) : undefined;
  const statusFilter = a.get("status") ? new Set((a.get("status") as string).split(",").map((s) => s.trim().toLowerCase())) : undefined;
  const since = a.get("since");
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new CliError("import: --since must be YYYY-MM-DD.");

  const out = outDir(a);
  const runId = checkRunId(a.get("run-id") ?? `${a.apply ? "run" : "dry"}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  report.runId = runId;
  const run = new RunDir(path.join(out, runId));
  const resume = a.has("resume");
  if (a.apply) {
    if (run.hasJournal() && !resume) throw new RunDirError(RUN_MESSAGES.exists);
    if (resume && !run.exists()) throw new RunDirError(RUN_MESSAGES.missing);
  }
  assertOutDirSafe(run.dir);
  if (entity === "events" && !run.readJson<SlugPlanEntry[] | null>("slug-plan.json", null)) throw new CliError("import: --entity events alone needs an existing slug-plan.json of the run id.");

  const reader = await openLegacy(a, v, siteId);
  const snapDir = a.get("snapshot-dir");
  if (snapDir) {
    if (!(reader instanceof LiveLegacyReader)) throw new CliError("import: --snapshot-dir needs a live source.");
    const mf = await writeSnapshot(reader, assertOutDirSafe(resolvePath(snapDir)), { tables: effectiveAllowList(m.source.tableAllowList), redact: m.redact, siteId, mappingSha256: mappingFingerprint(m) });
    console.log(`[import] snapshot written (${Object.entries(mf.tables).map(([t, x]) => `${t}=${x.rows}`).join(", ")})`);
  }

  // ── Central preflight (read-only) ──
  const payload = await getPayload({ config });
  const editorConfig = await editorConfigFactory.default({ config: payload.config });
  const tenant = await findOne(payload, "tenants", { slug: { equals: tenantSlug } });
  if (!tenant) throw new CliError(`import: tenant ${tenantSlug} not found in Central; create it first (Phase 1).`);
  const tenantId = tenant.id as number | string;
  const pillarId = new Map<string, number | string>();
  for (const p of await findAll(payload, "pillars", { tenant: { equals: tenantId } })) pillarId.set(String(p.slug), p.id as number | string);
  const subId = new Map<string, number | string>();
  const pillarSlugById = new Map([...pillarId.entries()].map(([s, id]) => [String(id), s]));
  for (const s of await findAll(payload, "subsections", { tenant: { equals: tenantId } })) subId.set(`${pillarSlugById.get(relId(s.pillar) ?? "") ?? "?"}/${String(s.slug)}`, s.id as number | string);
  const authorId = new Map<string, number | string>();
  for (const name of m.authors.staff) {
    const doc = await findOne(payload, "authors", { and: [{ tenant: { equals: tenantId } }, { name: { equals: name } }] });
    if (!doc) throw new CliError(`import: preflight failed: Central author "${name}" is missing in tenant ${tenantSlug} (the importer never creates authors).`);
    authorId.set(name, doc.id as number | string);
  }
  for (const p of profile().pillarSlugs) {
    if (!pillarId.has(p)) throw new CliError(`import: preflight failed: pillar ${p} missing in tenant ${tenantSlug}.`);
  }
  const countries: CountryRef[] = (await findAll(payload, "countries", {})).map((c) => ({ id: c.id as number | string, code: str(c.code), name: str(c.name) }));
  const tagId = new Map<string, number | string>();
  for (const t of await findAll(payload, "tags", { tenant: { equals: tenantId } })) tagId.set(String(t.slug), t.id as number | string);
  /** Tenant media doc for a stable filename, accepting Payload's `-<n>` upload rename (lowest id wins). */
  const findMediaByStable = async (stable: string): Promise<Doc | undefined> => {
    const stem = stable.slice(0, stable.lastIndexOf("."));
    const r = (await pFind(payload, "media", { where: { and: [{ tenant: { equals: tenantId } }, { filename: { like: stem } }] }, limit: 50, sort: "id" })) as unknown as { docs: Doc[] };
    return r.docs.find((d) => storedFilenameMatches(String(d.filename), stable));
  };
  console.log(`[import] preflight OK: tenant ${tenantSlug}, ${pillarId.size} pillars, ${subId.size} sub-sections, ${authorId.size} authors, ${countries.length} countries, ${tagId.size} tags`);

  // ── Second run (Amendment 5): items an EARLIER run (another run dir in this out dir) created and
  // that still exist in Central as import-marker rows. They keep their Central slug (so they are
  // skipped, never re-created) and their real Central author (fixed in the author plan). Empty on a
  // first run, which therefore plans exactly as before.
  const markerDocs = await findAll(payload, "articles", { and: [{ tenant: { equals: tenantId } }, { origin: { equals: MARKER.origin } }, { engineSourceName: { equals: MARKER.engineSourceName } }] }, { draft: true, depth: 0 });
  const markerById = new Map(markerDocs.map((d) => [String(d.id), d]));
  const priorDoc = new Map<string, Doc>();
  for (const r of allRunDirs(out)) {
    if (path.resolve(r.dir) === path.resolve(run.dir)) continue;
    for (const e of r.slugMap()) {
      const d = e.articleId !== undefined ? markerById.get(String(e.articleId)) : undefined;
      if (d) priorDoc.set(e.legacyId, d);
    }
  }
  // A fresh run must not silently adopt rows an earlier run created (adopted rows would belong to THIS
  // run's rollback): refuse when Central holds import rows that no run dir in --out has journaled.
  const journaledAnywhere = new Set(allRunDirs(out).flatMap((r) => r.slugMap()).map((e) => String(e.articleId)));
  const unjournaled = markerDocs.filter((d) => !journaledAnywhere.has(String(d.id))).length;
  if (unjournaled && !resume && !run.hasJournal()) {
    const msg = `import: Central already holds ${unjournaled} import rows that no run directory in --out has journaled; run a second migration with the SAME --out directory as the earlier run (its run dir must be present).`;
    if (a.apply) throw new CliError(msg);
    console.warn(`[import] WARNING ${msg}`);
  }
  const priorSlug = new Map([...priorDoc].map(([id, d]) => [id, String(d.slug)]));
  const authorName = new Map([...authorId].map(([n, id]) => [String(id), n]));

  // ── Slug plan over the WHOLE population (before any filter) ──
  const planRows = await reader.slugPlanRows();
  let plan = run.readJson<SlugPlanEntry[] | null>("slug-plan.json", null);
  const eventRows = m.events.enabled && entity !== "articles" ? await (async () => {
    const rows: Doc[] = [];
    for await (const p of reader.pages("events", "all", 500)) rows.push(...p);
    return rows.map(toLegacyEvent);
  })() : [];
  if (!plan) {
    const articlePlan = buildSlugPlan(planRows, m);
    const existingSlugs = new Set((await findAll(payload, "articles", { tenant: { equals: tenantId } }, { draft: true, select: { slug: true } })).map((d) => String(d.slug)));
    const allEvents = [];
    if (m.events.enabled) for await (const p of reader.pages("events", "all", 500)) allEvents.push(...p.map(toLegacyEvent));
    const eventPlan = planEventSlugs(allEvents.map((e) => ({ id: e.id, title: e.title, dateStart: e.dateStart })), [...articlePlan.map((x) => x.slug), ...existingSlugs]);
    plan = pinPriorSlugs([...articlePlan, ...eventPlan], priorSlug);
    if (a.apply) run.writeJson("slug-plan.json", plan);
  }
  const planById = new Map(plan.map((p) => [p.legacyId, p]));

  // ── Author plan (Amendment 3): ONCE per run over the COMPLETE planned set (all importable
  // articles + all events the run would create), never the rows still to import, so resume and
  // rollback + re-import give the same bylines. Pillar is NOT an input; it is only used for the report.
  type AuthorPlanEntry = { legacyId: string; author: string; pillar: string };
  let authorPlan = run.readJson<AuthorPlanEntry[] | null>("author-plan.json", null);
  if (!authorPlan) {
    const items: AuthorItem[] = [];
    const pillarOf = new Map<string, string>();
    const cal: CalendarRef[] = [];
    for await (const page of reader.pages("articles", ["id", "created_at", "status", "section", "subsection", "title", "published_at", "countries", "byline"], 500)) {
      for (const row of page) {
        const legacyId = String(row.id);
        if (str(row.section) === "events-awards" && str(row.subsection) === "industry-calendar") cal.push({ title: enText(row.title), date: isoOrNull(row.published_at)?.slice(0, 10) ?? null, legacyId });
        if (mapStatus(row.status, m).kind !== "import" || !planById.has(legacyId)) continue;
        const tx = resolveTaxonomy(row.section, row.subsection, m);
        if (!tx.ok || !pillarId.has(tx.t.pillar) || (tx.t.subSection && !subId.has(`${tx.t.pillar}/${tx.t.subSection}`)) || (SINGLE_HOME.has(tx.t.pillar) && tx.t.subSection)) continue;
        const countriesRaw = Array.isArray(row.countries) ? row.countries.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean) : [];
        items.push({ legacyId, slug: (planById.get(legacyId) as SlugPlanEntry).slug, publishedAt: publishedAtFor(row.published_at, row.created_at).iso, countries: countriesRaw, legacyByline: str(row.byline), kind: "article", section: tx.t.oldSection });
        pillarOf.set(legacyId, tx.t.pillar);
      }
    }
    if (m.events.enabled) {
      const allEv: ReturnType<typeof toLegacyEvent>[] = [];
      for await (const p of reader.pages("events", "all", 500)) allEv.push(...p.map(toLegacyEvent));
      for (const d of await findAll(payload, "articles", { and: [{ tenant: { equals: tenantId } }, { pillar: { equals: pillarId.get("events-awards") } }] }, { draft: true })) {
        if (isMarker(d)) continue;
        const briefs = Array.isArray(d.briefs) ? (d.briefs as Doc[]) : [];
        cal.push({ title: String(d.title ?? ""), date: String(briefs.find((b) => b.label === "Event date")?.value ?? String(d.publishedAt ?? "").slice(0, 10)), legacyId: `central:${String(d.id)}` });
      }
      for (const e of planEvents(allEv, cal, m.events.nearMatchThreshold).imports) {
        const legacyId = `event:${e.id}`;
        const pe = planById.get(legacyId);
        if (!pe) continue;
        items.push({ legacyId, slug: pe.slug, publishedAt: e.dateStart ? `${e.dateStart}T00:00:00.000Z` : null, countries: [], kind: "event" });
        pillarOf.set(legacyId, "events-awards");
      }
    }
    // Existing items keep their REAL Central author; only new items are balanced (Amendment 5).
    // An existing item credited to an author outside the staff list is left out: it is never created.
    const fixed = new Map<string, string>();
    const keep = items.filter((it) => {
      const d = priorDoc.get(it.legacyId);
      if (!d) return true;
      const n = authorName.get(relId(d.author) ?? "");
      if (n === undefined) return false;
      fixed.set(it.legacyId, n);
      return true;
    });
    items.splice(0, items.length, ...keep);
    const mode = m.authors.distribute.mode ?? "even";
    let assign: Map<string, string>;
    if (mode === "even") assign = assignAuthors(items, m.authors.distribute, m.authors.map, fixed);
    else {
      const r = assignByRule(items, mode, m.authors.distribute.pool, m.authors.bySection ?? {}, fixed);
      assign = r.assign;
      report.authorSectionFallbacks = r.sectionFallbacks;
    }
    authorPlan = items.map((it) => ({ legacyId: it.legacyId, author: assign.get(it.legacyId) as string, pillar: pillarOf.get(it.legacyId) as string }));
    if (a.apply) run.writeJson("author-plan.json", authorPlan);
  }
  const authorOf = new Map(authorPlan.map((e) => [e.legacyId, e.author]));
  {
    const t = authorTotals(authorOf, m.authors.distribute.pool);
    report.authors.planTotals = t.totals;
    report.authors.planSpread = t.spread;
    report.authors.pillarsUnderTwoAuthors = pillarsUnderTwoAuthors(authorOf, new Map(authorPlan.map((e) => [e.legacyId, e.pillar])));
    // Actual totals = every import-marker row already in Central (its real author) + the planned new items.
    const actual = new Map<string, string>();
    for (const d of markerDocs) {
      const n = authorName.get(relId(d.author) ?? "");
      if (n !== undefined) actual.set(`central:${String(d.id)}`, n);
    }
    for (const e of authorPlan) if (!priorDoc.has(e.legacyId)) actual.set(e.legacyId, e.author);
    const at = authorTotals(actual, m.authors.distribute.pool);
    report.authors.existingInCentral = markerDocs.length;
    report.authors.fixedFromCentral = [...authorPlan].filter((e) => priorDoc.has(e.legacyId)).length;
    report.authors.actualTotals = at.totals;
    report.authors.actualSpread = at.spread;
    for (const n of authorOf.values()) if (!authorId.has(n)) throw new CliError(`import: author "${n}" is not in the Central author preflight (the importer never creates authors).`);
    console.log(`[import] authors (plan, ${authorOf.size} items): ${Object.entries(t.totals).map(([n, c]) => `${n} ${c}`).join(", ")}; spread ${t.spread}; pillars with < 2 authors: ${report.authors.pillarsUnderTwoAuthors.join(", ") || "none"}`);
  }
  for (const p of plan) if (p.slugChanged) report.slugChanged.push({ legacyId: p.legacyId, ...p.slugChanged });
  report.duplicates = plan.filter((p) => p.duplicateOf).length;

  // ── Run state + journals ──
  const now = new Date().toISOString();
  let state: RunState | undefined = run.state();
  if (a.apply) {
    state = state ?? { runId, startedAt: now, tenant: tenantSlug, mappingFingerprint: mappingFingerprint(m), provisional: v.provisional.map((p) => p.key), invocations: [], tagsCreated: [] };
    state.mappingFingerprint = mappingFingerprint(m);
    state.provisional = v.provisional.map((p) => p.key);
    state.invocations.push({ at: now, apply: true, argv: process.argv.slice(2).filter((x) => !x.startsWith("--confirm-host")) });
    run.writeJson("state.json", state);
  }
  const slugJ = a.apply ? run.slugJournal() : undefined;
  const mediaJ = a.apply ? run.mediaJournal() : undefined;
  const journaled = new Map(run.slugMap().map((e) => [e.legacyId, e]));
  // Marker rows journaled by ANOTHER run directory are owned by that run: never adopted here (A13-R05).
  const otherRuns = new Set<string>();
  for (const r of allRunDirs(out)) if (path.resolve(r.dir) !== path.resolve(run.dir)) for (const e of r.slugMap()) if (e.articleId !== undefined) otherRuns.add(String(e.articleId));
  const mediaMap = run.mediaMap();

  // N-12: resolve pending media entries left by a crash.
  if (a.apply && mediaJ && state) {
    for (const e of mediaMap.filter((x) => x.origin === "created-pending")) {
      const doc = await findMediaByStable(e.filename);
      const resolved: MediaMapEntry = doc
        ? { ...e, mediaId: doc.id as number | string, origin: String(doc.createdAt) >= state.startedAt ? "created" : "adopted" }
        : { ...e, origin: "pending-absent" };
      mediaJ.append(resolved);
    }
  }
  const mediaCreatedThisRun = new Map(run.mediaMap().filter((x) => x.origin === "created" && x.mediaId !== undefined).map((x) => [x.filename, x.mediaId as number | string]));
  const mediaCache = new Map<string, { id?: number | string; origin: "created" | "adopted" } | null>();
  const controls = new FailureControls(stopAfter, m.media.failureBudgetPercent);
  const provenanceFile = run.p("provenance.ndjson");
  const rejectsLines: string[] = [];
  const oldOrigin = m.urls.oldOrigin.replace(/\/$/, "");
  let createdCount = 0;
  let mediaUploads = 0;
  let journaledCount = 0;

  const ensureTag = async (t: TagRef): Promise<number | string | undefined> => {
    const hit = tagId.get(t.slug);
    if (hit !== undefined) return hit;
    report.tagsCreated.push(t.slug);
    if (!a.apply) {
      tagId.set(t.slug, 0);
      return undefined;
    }
    const created = (await pCreate(payload, "tags", { tenant: tenantId, slug: t.slug, title: t.title }, { context: ctx, locale: "en" })) as unknown as Doc;
    tagId.set(t.slug, created.id as number | string);
    state?.tagsCreated.push({ id: created.id as number | string, slug: t.slug });
    return created.id as number | string;
  };

  const ensureHero = async (legacyId: string, rawUrl: string, alt: string, credit: string): Promise<number | string | undefined> => {
    const filename = stableFilename(rawUrl, profile().mediaPrefix);
    if (mediaCache.has(filename)) return mediaCache.get(filename)?.id;
    const existing = await findMediaByStable(filename);
    if (existing) {
      const origin = mediaCreatedThisRun.has(filename) ? "created" : "adopted";
      mediaCache.set(filename, { id: existing.id as number | string, origin });
      if (origin === "adopted") report.mediaAdopted++;
      mediaJ?.append({ articleLegacyId: legacyId, role: "hero", mediaId: existing.id as number | string, filename, origin } satisfies MediaMapEntry);
      return existing.id as number | string;
    }
    if (m.media.hotlinkPolicy === "skip") return undefined;
    const res = await fetchImageWithRetry(rawUrl, { allow: m.media.hostAllowlist ?? [], rewrite: m.media.hostRewrite ?? {}, maxBytes: m.media.maxBytes, timeoutMs: m.media.fetchTimeoutMs, baseDelayMs: 200 });
    controls.recordMedia(res.ok);
    if (!res.ok) {
      bump(report.mediaFailed, res.reason);
      mediaCache.set(filename, null);
      return undefined;
    }
    mediaJ?.append({ articleLegacyId: legacyId, role: "hero", filename, origin: "created-pending", startedAt: new Date().toISOString() } satisfies MediaMapEntry);
    const created = (await pCreate(payload, "media", { tenant: tenantId, alt: alt || filename, ...(credit ? { credit } : {}) }, { file: { data: res.bytes, mimetype: res.mime, name: filename, size: res.bytes.length }, context: ctx, locale: "en" })) as unknown as Doc;
    mediaUploads++;
    if (hooks.killAfterMediaUpload !== undefined && mediaUploads >= hooks.killAfterMediaUpload) {
      console.error(`[import] MIGRATE_TEST_KILL_AFTER_MEDIA_UPLOAD=${hooks.killAfterMediaUpload}: exiting before the media resolution line (test hook)`);
      process.exit(137);
    }
    const sha = (await import("node:crypto")).createHash("sha256").update(res.bytes).digest("hex");
    mediaJ?.append({ articleLegacyId: legacyId, role: "hero", mediaId: created.id as number | string, filename, sha256: sha, origin: "created" } satisfies MediaMapEntry);
    mediaCreatedThisRun.set(filename, created.id as number | string);
    mediaCache.set(filename, { id: created.id as number | string, origin: "created" });
    report.mediaCreated++;
    return created.id as number | string;
  };

  /** Look up (tenant, slug); adopt marker rows, refuse foreign ones. Returns true when the row must not be created. */
  const handleExisting = async (legacyId: string, slug: string, kind: "article" | "event", status: string, extra: Partial<SlugMapEntry>): Promise<boolean> => {
    const existing = await findOne(payload, "articles", { and: [{ tenant: { equals: tenantId } }, { slug: { equals: slug } }] }, true);
    if (!existing) return false;
    if (!isMarker(existing)) {
      report.slugConflictForeign.push(`${legacyId} -> ${slug}`);
      return true;
    }
    if (otherRuns.has(String(existing.id))) {
      report.ownedByOtherRun++;
      report.skippedExisting++;
      return true;
    }
    if (Number(existing.version) === 1) {
      report.baselineReconstructed++;
      report.skippedExisting++;
      if (slugJ) {
        const entry: SlugMapEntry = {
          legacyId, kind, slug, articleId: existing.id as number | string, status, createdVersion: 1, createdUpdatedAt: String(existing.updatedAt),
          baselineVersion: 1, baselineUpdatedAt: String(existing.updatedAt), legacyCreatedAt: extra.legacyCreatedAt ?? null, legacyUpdatedAt: extra.legacyUpdatedAt ?? null,
          ...extra, baselineReconstructed: true, adopted: true, createdAtRun: runId,
        };
        slugJ.append(entry);
        journaled.set(legacyId, entry);
      }
    } else report.orphanUnknown.push(`${legacyId} -> ${slug} (version ${String(existing.version)})`);
    return true;
  };

  /** Create with one retry on connection errors (slug looked up first, N-15b). */
  const createArticle = async (data: Doc, draft: boolean): Promise<Doc> => {
    try {
      return (await pCreate(payload, "articles", data, { context: ctx, draft, locale: "en" })) as unknown as Doc;
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      const again = await findOne(payload, "articles", { and: [{ tenant: { equals: tenantId } }, { slug: { equals: data.slug } }] }, true);
      if (again && isMarker(again)) return again;
      return (await pCreate(payload, "articles", data, { context: ctx, draft, locale: "en" })) as unknown as Doc;
    }
  };

  const afterCreate = async (created: Doc, entry: Omit<SlugMapEntry, "articleId" | "createdVersion" | "createdUpdatedAt" | "baselineVersion" | "baselineUpdatedAt">) => {
    createdCount++;
    if (hooks.killBeforeJournal !== undefined && createdCount >= hooks.killBeforeJournal) {
      console.error(`[import] MIGRATE_TEST_KILL_BEFORE_JOURNAL=${hooks.killBeforeJournal}: exiting before the journal line (test hook)`);
      process.exit(137);
    }
    // E8: baseline from an immediate draft:true readback.
    const rb = await findOne(payload, "articles", { id: { equals: created.id } }, true);
    const readUpdated = String(rb?.updatedAt ?? created.updatedAt);
    if (readUpdated === String(created.updatedAt)) report.e8.createVsReadbackEqual++;
    else report.e8.createVsReadbackDiffer++;
    const full: SlugMapEntry = {
      ...entry,
      articleId: created.id as number | string,
      createdVersion: Number(rb?.version ?? created.version ?? 1),
      createdUpdatedAt: readUpdated,
      baselineVersion: Number(rb?.version ?? created.version ?? 1),
      baselineUpdatedAt: readUpdated,
      createdAtRun: runId,
    };
    slugJ?.append(full);
    journaled.set(full.legacyId, full);
    journaledCount++;
    if (hooks.killAfter !== undefined && journaledCount >= hooks.killAfter) {
      console.error(`[import] MIGRATE_TEST_KILL_AFTER=${hooks.killAfter}: exiting between articles (test hook)`);
      process.exit(137);
    }
  };

  const flushBatch = () => {
    if (!a.apply) return;
    run.compactSlugMap();
    run.compactMediaMap();
    if (state) run.writeJson("state.json", state);
  };

  const checkStop = () => {
    const s = controls.stopReason();
    if (s) {
      report.stop = s;
      throw new StopRun(s);
    }
  };

  let considered = 0;
  const calendar: CalendarRef[] = [];
  try {
    // ── Articles ──
    if (entity !== "events") {
      outer: for await (const page of reader.pages("articles", ARTICLE_COLUMNS, batch)) {
        for (const row of page) {
          const legacyId = String(row.id);
          if (str(row.section) === "events-awards" && str(row.subsection) === "industry-calendar") {
            calendar.push({ title: enText(row.title), date: isoOrNull(row.published_at)?.slice(0, 10) ?? null, legacyId });
          }
          if (idsFilter && !idsFilter.has(legacyId.toLowerCase())) continue;
          if (statusFilter && !statusFilter.has(str(row.status).toLowerCase())) continue;
          if (since && (isoOrNull(row.created_at) ?? "") < `${since}T00:00:00.000Z`) continue;
          if (limit !== undefined && considered >= limit) break outer;
          considered++;
          report.seen++;
          const sd = mapStatus(row.status, m);
          if (sd.kind !== "import") {
            bump(report.rejects, sd.kind === "skip" ? `skip: ${sd.reason}` : `reject: ${sd.reason}`);
            rejectsLines.push(JSON.stringify({ legacyId, kind: sd.kind, reason: sd.reason }));
            continue;
          }
          const tx = resolveTaxonomy(row.section, row.subsection, m);
          if (!tx.ok) {
            bump(report.rejects, `reject: ${tx.reason}`);
            rejectsLines.push(JSON.stringify({ legacyId, kind: "reject", reason: tx.reason }));
            continue;
          }
          const pid = pillarId.get(tx.t.pillar);
          const sid = tx.t.subSection ? subId.get(`${tx.t.pillar}/${tx.t.subSection}`) : undefined;
          if (pid === undefined || (tx.t.subSection && sid === undefined)) {
            bump(report.rejects, "reject: unmapped-category");
            rejectsLines.push(JSON.stringify({ legacyId, kind: "reject", reason: `unmapped-category ${tx.t.pillar}/${tx.t.subSection ?? ""}` }));
            continue;
          }
          if (SINGLE_HOME.has(tx.t.pillar) && tx.t.subSection) {
            bump(report.rejects, "reject: press-room-sub-section");
            continue;
          }
          const pe = planById.get(legacyId);
          if (!pe) {
            bump(report.rejects, "reject: not-in-slug-plan");
            continue;
          }
          const slug = pe.slug;
          const oldSlug = str(row.slug) || slug;
          const legacyCreatedAt = isoOrNull(row.created_at);
          const legacyUpdatedAt = isoOrNull(row.updated_at);
          const body = sectionsToHtml(row.body_sections, m.body.lineBreaks);
          const textLinks = (body.paragraphs.join(" ").match(new RegExp(`${oldOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s)"']+`, "g")) ?? []).map((u) => u.replace(/[.,;:]+$/, ""));
          const entryBase = {
            legacyId, kind: "article" as const, slug, status: sd.status, legacyCreatedAt, legacyUpdatedAt,
            oldUrl: oldArticleUrl(m.urls.articlePathTemplate, { section: tx.t.oldSection, sub: tx.t.oldSub, slug: oldSlug, id: legacyId, publishedAt: isoOrNull(row.published_at) }),
            oldSection: tx.t.oldSection, oldSub: tx.t.oldSub, pillar: tx.t.pillar, ...(tx.t.subSection ? { subSection: tx.t.subSection } : {}),
            rehomed: tx.t.rehomed, ...(pe.duplicateOf ? { duplicateOf: pe.duplicateOf } : {}), internalLinkRewritable: false,
            ...(textLinks.length ? { textLinks } : {}),
          };
          if (journaled.has(legacyId)) {
            report.skippedExisting++;
            continue;
          }
          if (await handleExisting(legacyId, slug, "article", sd.status, entryBase)) continue;

          // transforms
          const title = enText(row.title) || `Untitled ${legacyId.slice(0, 8)}`;
          report.droppedSections += body.droppedSections;
          const bodyImgs = bodyImageUrls(row.body_sections);
          if (body.tagLikeText) report.tagLikeTextRows++;
          if (Buffer.byteLength(body.html) > m.body.maxBytes) {
            bump(report.rejects, "reject: body-too-large");
            continue;
          }
          const lexical = htmlToLexical(editorConfig, body.html);
          const authorName = authorOf.get(legacyId);
          if (!authorName) {
            bump(report.rejects, "reject: no-author-assignment");
            continue;
          }
          const ft = formatTag(row.format, m);
          if (!ft && str(row.format)) report.formatTagSkipped++;
          const tagRefs = [...(ft ? [ft] : []), ...legacyTags(row.tags, m)];
          const cr = resolveCountries(row.countries, countries, m.countries.match);
          for (const u of cr.unmatched) bump(report.countriesUnmatched, u);
          const rm = readMinFor(row.read_minutes, wordCount(body.text), m.readMin.wpm);
          if (rm.computed) report.readMinComputed++;
          const pub = publishedAtFor(row.published_at, row.created_at);
          if (pub.fellBack) report.publishedAtFellBack++;
          if (row.seo && typeof row.seo === "object" && Object.keys(row.seo as object).length) report.seoDropped++;
          if (row.featured === true) report.featuredFlag++;
          if (row.is_hero === true) report.isHeroFlag++;
          if (tx.t.rehomed) report.rehomed++;
          const sw = statusWrite(sd.status);
          bump(report.perPillar, tx.t.pillar);
          bump(report.perSub, `${tx.t.pillar}/${tx.t.subSection ?? ""}`);
          report.planned++;
          if (!a.apply) continue;

          let heroUrl = str(row.featured_image);
          if (!heroUrl && m.media.bodyImages === "hero-if-missing" && bodyImgs.length) {
            heroUrl = bodyImgs[0] as string;
            report.bodyImageUsedAsHero++;
            report.bodyImagesDropped += bodyImgs.length - 1;
          } else report.bodyImagesDropped += bodyImgs.length;
          let heroId: number | string | undefined;
          if (heroUrl) heroId = await ensureHero(legacyId, heroUrl, title, stripPhotoLabel(row.featured_image_credit));
          if (heroId === undefined) report.heroMissing++;
          const tagIds: (number | string)[] = [];
          for (const t of tagRefs) {
            const id = await ensureTag(t);
            if (id !== undefined && !tagIds.includes(id)) tagIds.push(id);
          }
          const sourceUrl = typeof row.source_url === "string" && row.source_url !== "" ? row.source_url : undefined;
          const data: Doc = {
            tenant: tenantId,
            title,
            slug,
            dek: enText(row.excerpt) || undefined,
            ...(lexical ? { body: lexical } : {}),
            workflowStatus: sw.workflowStatus,
            ...(sw._status ? { _status: sw._status } : {}),
            publishedAt: pub.iso ?? new Date().toISOString(),
            pillar: pid,
            ...(sid !== undefined ? { subSection: sid } : {}),
            author: authorId.get(authorName),
            ...(tagIds.length ? { tags: tagIds } : {}),
            ...(cr.ids.length ? { country: cr.ids[0], countries: cr.ids } : {}),
            ...(heroId !== undefined ? { heroImage: heroId } : {}),
            readMin: rm.readMin,
            ...(takeawaysText(row.takeaways) ? { takeaways: takeawaysText(row.takeaways) } : {}),
            pinnedToLatest: false,
            origin: MARKER.origin,
            editedByHuman: true,
            ...(sourceUrl ? { engineSourceUrl: sourceUrl } : {}),
            engineSourceName: MARKER.engineSourceName,
          };
          try {
            const created = await createArticle(data, sw.draft);
            await afterCreate(created, entryBase);
            appendFileSync(provenanceFile, JSON.stringify(provenanceRow(row)) + "\n", { mode: 0o600 });
            report.imported++;
            bump(report.authors.assignedThisRun, authorName);
            bump(report.importedByStatus, sd.status);
            controls.recordArticle(true);
          } catch (err) {
            report.failed.push(`${legacyId} (${slug}): ${String((err as Error).message).slice(0, 200)}`);
            controls.recordArticle(false);
          }
          checkStop();
        }
        flushBatch();
      }
    } else {
      for await (const page of reader.pages("articles", ["id", "title", "published_at", "section", "subsection"], 500)) {
        for (const row of page) if (str(row.section) === "events-awards" && str(row.subsection) === "industry-calendar") calendar.push({ title: enText(row.title), date: isoOrNull(row.published_at)?.slice(0, 10) ?? null, legacyId: String(row.id) });
      }
    }

    // ── Events (after articles) ──
    if (entity !== "articles" && m.events.enabled && limit === undefined && !idsFilter && !statusFilter && !since) {
      // existing (non-legacy) calendar articles in Central also count for de-dupe
      const existingCal = await findAll(payload, "articles", { and: [{ tenant: { equals: tenantId } }, { pillar: { equals: pillarId.get("events-awards") } }] }, { draft: true });
      for (const d of existingCal) {
        if (isMarker(d)) continue;
        const briefs = Array.isArray(d.briefs) ? (d.briefs as Doc[]) : [];
        const date = String(briefs.find((b) => b.label === "Event date")?.value ?? String(d.publishedAt ?? "").slice(0, 10));
        calendar.push({ title: String(d.title ?? ""), date, legacyId: `central:${String(d.id)}` });
      }
      report.events.seen = eventRows.length;
      const ed = planEvents(eventRows, calendar, m.events.nearMatchThreshold);
      report.events.duplicatesSkipped = ed.duplicates.map((d) => `${d.event.id} = ${d.of}`);
      report.events.nearListed = ed.near.map((n) => ({ id: n.event.id, of: n.of, similarity: n.similarity }));
      for (const e of ed.imports) {
        const legacyId = `event:${e.id}`;
        const pe = planById.get(legacyId);
        if (!pe) {
          bump(report.rejects, "reject: event-not-in-slug-plan");
          continue;
        }
        const status = eventStatus(e);
        const entryBase = {
          legacyId, kind: "event" as const, slug: pe.slug, status, legacyCreatedAt: null, legacyUpdatedAt: null,
          pillar: "events-awards", subSection: "industry-calendar", internalLinkRewritable: false,
        };
        if (journaled.has(legacyId)) {
          report.skippedExisting++;
          continue;
        }
        if (await handleExisting(legacyId, pe.slug, "event", status, entryBase)) continue;
        if (!authorOf.has(legacyId)) {
          bump(report.rejects, "reject: no-author-assignment");
          continue;
        }
        report.planned++;
        report.events.publishedAtFromDateStart++; // events have no created_at: publishedAt = date_start (reported)
        if (status === "archived") report.events.archived++;
        if (!a.apply) continue;
        const html = e.note ? `<p>${e.note.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>` : "<p>Event listing from the industry calendar.</p>";
        const sw = statusWrite(status);
        const data: Doc = {
          tenant: tenantId,
          title: e.title,
          slug: pe.slug,
          ...(eventDek(e) ? { dek: eventDek(e) } : {}),
          body: htmlToLexical(editorConfig, html),
          workflowStatus: sw.workflowStatus,
          ...(sw._status ? { _status: sw._status } : {}),
          publishedAt: e.dateStart ? new Date(`${e.dateStart}T00:00:00.000Z`).toISOString() : new Date().toISOString(),
          pillar: pillarId.get("events-awards"),
          subSection: subId.get("events-awards/industry-calendar"),
          author: authorId.get(authorOf.get(legacyId) as string),
          briefs: eventBriefs(e),
          readMin: 1,
          origin: MARKER.origin,
          editedByHuman: true,
          engineSourceName: MARKER.engineSourceName,
        };
        try {
          const created = await createArticle(data, sw.draft);
          await afterCreate(created, entryBase);
          report.events.imported++;
          report.imported++;
          bump(report.authors.assignedThisRun, authorOf.get(legacyId) as string);
          bump(report.importedByStatus, `event:${status}`);
          controls.recordArticle(true);
        } catch (err) {
          report.failed.push(`${legacyId}: ${String((err as Error).message).slice(0, 200)}`);
          controls.recordArticle(false);
        }
        checkStop();
      }
      flushBatch();
    }
    const finalStop = controls.stopReason();
    if (finalStop && !report.stop) report.stop = finalStop;
  } catch (err) {
    if (!(err instanceof StopRun)) throw err;
  } finally {
    slugJ?.close();
    mediaJ?.close();
  }

  // ── Pass 1 link flags, collisions, outputs ──
  const all = a.apply ? run.compactSlugMap() : [];
  if (a.apply) {
    run.compactMediaMap();
    const byOld = new Map<string, SlugMapEntry>();
    for (const e of all) if (e.oldUrl) byOld.set(normaliseKey(e.oldUrl) ?? e.oldUrl, e);
    const flagJ = run.slugJournal();
    for (const e of all) {
      if (!e.textLinks?.length || e.internalLinkRewritable) continue;
      const hit = e.textLinks.some((u) => {
        try {
          const target = byOld.get(normaliseKey(new URL(u).pathname) ?? "");
          return target !== undefined && target.status === "published";
        } catch {
          return false;
        }
      });
      if (hit) {
        flagJ.append({ legacyId: e.legacyId, internalLinkRewritable: true });
        report.internalLinkRewritable++;
      }
    }
    flagJ.close();
    const finalMap = run.compactSlugMap();
    const ts = generateTimestampsFix(finalMap.map((e) => ({ slug: e.slug, kind: e.kind, legacyCreatedAt: e.legacyCreatedAt, legacyUpdatedAt: e.legacyUpdatedAt })), { tenantSlug, runId, markerSourceName: MARKER.engineSourceName });
    writeFileSafe(run.p("timestamps-fix.sql"), ts.sql);
    run.writeJson("timestamps-baseline.json", ts.baseline);
    run.writeJson("timestamps-fix.skipped.json", ts.skipped);
    report.timestamps = { blocks: ts.counts.blocks, slugNotSqlSafe: ts.counts.slugNotSqlSafe, timestampsNoSource: ts.counts.timestampsNoSource };
    if (state) run.writeJson("state.json", state);
  }
  // source-url collisions (report only; stored values stay exact)
  const canon = new Map<string, string[]>();
  for await (const page of reader.pages("articles", ["id", "source_url", "status", "created_at"], 500)) {
    for (const r of page) {
      if (mapStatus(r.status, m).kind !== "import" || !str(r.source_url)) continue;
      const c = canonicalSourceUrl(str(r.source_url));
      canon.set(c, [...(canon.get(c) ?? []), String(r.id)]);
    }
  }
  report.sourceUrlCollisions = [...canon.entries()].filter(([, ids]) => ids.length > 1).map(([source_url, legacyIds]) => ({ source_url, legacyIds }));
  assertOutDirSafe(run.dir);
  writeFileSafe(run.p("rejects.ndjson"), rejectsLines.join("\n") + (rejectsLines.length ? "\n" : ""));
  run.writeJson("query-log.json", reader.queryLog());
  await reader.close();
  report.durationMs = Date.now() - started;
  run.writeJson("import-report.json", report);
  writeFileSafe(run.p("import-report.md"), renderReport(report));
  console.log(renderReport(report));
  const bad = report.failed.length > 0 || report.slugConflictForeign.length > 0 || report.orphanUnknown.length > 0 || report.stop !== null;
  if (report.stop) console.error(`[import] ${report.stop}`);
  return bad ? 2 : 0;
}

class StopRun extends Error {}

function renderReport(r: Report): string {
  const kv = (o: Record<string, number>) => Object.entries(o).map(([k, n]) => `  - ${k}: ${n}`).join("\n") || "  - (none)";
  const list = (l: string[], max = 30) => (l.length ? l.slice(0, max).map((x) => `  - ${x}`).join("\n") + (l.length > max ? `\n  - ... +${l.length - max}` : "") : "  - (none)");
  return `# ${profile().id.toUpperCase()} legacy import report (${r.mode === "apply" ? "APPLY" : "DRY RUN: nothing written"})

- run id: ${r.runId}
- rows considered: ${r.seen}; planned for create: ${r.planned}; imported: ${r.imported}; skippedExisting: ${r.skippedExisting}
- imported by status:
${kv(r.importedByStatus)}
- rejects / skips:
${kv(r.rejects)}
- failed: ${r.failed.length}
${list(r.failed)}
- slugConflictForeign: ${r.slugConflictForeign.length}
${list(r.slugConflictForeign)}
- baselineReconstructed: ${r.baselineReconstructed}; orphanUnknown: ${r.orphanUnknown.length}; owned by another run (not adopted): ${r.ownedByOtherRun}
- per pillar:
${kv(r.perPillar)}
- per pillar/sub-section:
${kv(r.perSub)}
- re-homed: ${r.rehomed}; duplicate slugs suffixed: ${r.duplicates}; slugChanged: ${r.slugChanged.length}
- heroMissing: ${r.heroMissing}; media created: ${r.mediaCreated}; adopted: ${r.mediaAdopted}; failed:
${kv(r.mediaFailed)}
- tags created: ${r.tagsCreated.length}; formatTagSkipped: ${r.formatTagSkipped}
- countriesUnmatched:
${kv(r.countriesUnmatched)}
- authors (plan totals, spread ${r.authors.planSpread}):
${kv(r.authors.planTotals)}
- authors actual totals over Central (${r.authors.existingInCentral} existing import rows, ${r.authors.fixedFromCentral} kept their Central author) + new items, spread ${r.authors.actualSpread}:
${kv(r.authors.actualTotals)}
- authors assigned in this run:
${kv(r.authors.assignedThisRun)}
- pillars with fewer than 2 distinct authors: ${r.authors.pillarsUnderTwoAuthors.join(", ") || "none"}
- readMinComputed: ${r.readMinComputed}; publishedAtFellBack: ${r.publishedAtFellBack}
- seoDropped: ${r.seoDropped}; featured flag: ${r.featuredFlag}; is_hero flag: ${r.isHeroFlag} (not mapped to pinnedToLatest)
- body images (body_sections[].image): dropped ${r.bodyImagesDropped}, used as hero ${r.bodyImageUsedAsHero}; author section fallbacks (slug hash): ${r.authorSectionFallbacks}
- droppedSections: ${r.droppedSections}; rows with tag-like text (kept as text): ${r.tagLikeTextRows}
- sourceUrlCollisions: ${r.sourceUrlCollisions.length}
- internalLinkRewritable: ${r.internalLinkRewritable}
- events: seen ${r.events.seen}, imported ${r.events.imported}, duplicates skipped ${r.events.duplicatesSkipped.length}, near listed ${r.events.nearListed.length}, archived ${r.events.archived}
- E8 create vs draft readback updatedAt: equal ${r.e8.createVsReadbackEqual}, differ ${r.e8.createVsReadbackDiffer}
- timestamps-fix.sql: blocks ${r.timestamps.blocks}, slugNotSqlSafe ${r.timestamps.slugNotSqlSafe}, timestampsNoSource ${r.timestamps.timestampsNoSource}
- stop: ${r.stop ?? "none"}
- duration: ${Math.round(r.durationMs / 1000)} s
`;
}

runMain("import", main);
