/**
 * Implementation of `scripts/migrate/rollback-gtp-import.ts` (gtp-launch P4,
 * 7.10 as superseded by A11-S04, A12-N06/N09/N12, A13-R05, E15, E16).
 *
 * Deletes ONLY rows of one run that still carry the import marker AND are
 * untouched since the import: current `version == baselineVersion` AND
 * current `updatedAt` equals `baselineUpdatedAt` or the timestamps-baseline.json
 * value for the slug. `--include-edited` overrides the untouched test (marker
 * still required). Media: only `origin: created` docs no surviving article
 * references (this run's media map + a heroImage relationship query); adopted
 * media is never deleted. Tags created by the run are deleted when unused.
 * Dry run by default; the local-DB guard runs in every mode; `--require-final`
 * is never enforced for rollback. The run directory is kept (audit trail).
 *
 *   npm run migrate:gtp:rollback -- --run-id <id> [--apply] [--confirm-host=<host>] [--include-edited] [--list-orphans] [--include-orphans] [--out dir]
 */
import "../../lib/env";
import path from "node:path";
import { getPayload } from "payload";
import config from "../../../payload.config";
import { pDelete, pFind, pUpdate } from "../../lib/payload-loose";
import { CliError } from "./args";
import { parseCommand } from "./cli-spec";
import { assertImportTenant, centralTarget, outDir, runMain } from "./cli-common";
import { untouched } from "./rollback-rules";
import { RunDir, RunDirError, RUN_MESSAGES, checkRunId, journaledArticleIds } from "./run-dir";

type Doc = Record<string, unknown>;
type P = Awaited<ReturnType<typeof getPayload>>;
const MARKER = { origin: "import", engineSourceName: "legacy:globaltravelpost" };
const ctx = { disableRevalidate: true, skipTranslationEnqueue: true };

async function findAll(payload: P, collection: string, where: Doc, extra: Doc = {}): Promise<Doc[]> {
  const out: Doc[] = [];
  for (let page = 1; ; page++) {
    const r = (await pFind(payload, collection, { where, limit: 500, page, ...extra })) as unknown as { docs: Doc[]; hasNextPage?: boolean };
    out.push(...r.docs);
    if (!r.hasNextPage) return out;
  }
}
const relId = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : typeof v === "object" ? String((v as Doc).id) : String(v));
const isMarker = (d: Doc) => d.origin === MARKER.origin && d.engineSourceName === MARKER.engineSourceName;

async function main(): Promise<number> {
  const a = parseCommand("rollback", process.argv.slice(2));
  const runIdRaw = a.get("run-id");
  if (!runIdRaw) throw new CliError("rollback: --run-id is required.");
  const runId = checkRunId(runIdRaw);
  const central = centralTarget(a, a.apply);
  const tenantSlug = assertImportTenant();
  const out = outDir(a);
  const run = new RunDir(path.join(out, runId));
  if (!run.exists()) throw new RunDirError(RUN_MESSAGES.missing);
  const entries = run.slugMap();
  const media = run.mediaMap();
  const tsBaseline = run.readJson<Record<string, string>>("timestamps-baseline.json", {});
  const state = run.state();
  const payload = await getPayload({ config });
  const tenant = ((await pFind(payload, "tenants", { where: { slug: { equals: tenantSlug } }, limit: 1 })) as unknown as { docs: Doc[] }).docs[0];
  if (!tenant) throw new CliError(`rollback: tenant ${tenantSlug} not found.`);
  const tenantId = tenant.id as number | string;
  const rep = {
    mode: a.apply ? "apply" : "dry-run",
    runId,
    target: central.banner,
    entries: entries.length,
    toDelete: [] as string[],
    keptEdited: [] as string[],
    keptNotMarker: [] as string[],
    alreadyGone: [] as string[],
    deleted: 0,
    archivedFallback: [] as string[],
    orphans: [] as string[],
    orphansDeleted: 0,
    mediaDeleted: 0,
    mediaKeptReferenced: 0,
    mediaKeptAdopted: 0,
    tagsDeleted: 0,
    errors: [] as string[],
  };

  const deleteIds: (number | string)[] = [];
  for (const e of entries) {
    const doc = ((await pFind(payload, "articles", { where: { id: { equals: e.articleId } }, limit: 1, draft: true })) as unknown as { docs: Doc[] }).docs[0];
    if (!doc) {
      rep.alreadyGone.push(`${e.legacyId} (${e.slug})`);
      continue;
    }
    if (!isMarker(doc) || relId(doc.tenant) !== String(tenantId)) {
      rep.keptNotMarker.push(`${e.legacyId} (${e.slug})`);
      continue;
    }
    if (!a.has("include-edited") && !untouched(doc, e, tsBaseline)) {
      rep.keptEdited.push(`${e.legacyId} (${e.slug})`);
      continue;
    }
    rep.toDelete.push(`${e.legacyId} (${e.slug})`);
    deleteIds.push(doc.id as number | string);
  }

  // Orphans: marker rows of the tenant absent from the journals of EVERY run directory (A13-R05).
  if (a.has("list-orphans") || a.has("include-orphans")) {
    const journaled = journaledArticleIds(out);
    const markerRows = await findAll(payload, "articles", { and: [{ tenant: { equals: tenantId } }, { origin: { equals: MARKER.origin } }, { engineSourceName: { equals: MARKER.engineSourceName } }] }, { draft: true });
    for (const d of markerRows) {
      if (journaled.has(String(d.id))) continue;
      rep.orphans.push(`${String(d.id)} (${String(d.slug)}, version ${String(d.version)}, createdAt ${String(d.createdAt)})`);
      if (a.has("include-orphans") && state && String(d.createdAt) >= state.startedAt && Number(d.version) === 1) deleteIds.push(d.id as number | string);
    }
  }

  // Media decision.
  const deleting = new Set(deleteIds.map(String));
  const deletedLegacy = new Set(entries.filter((e) => deleting.has(String(e.articleId))).map((e) => e.legacyId));
  const survivingRefs = new Set(media.filter((m) => !deletedLegacy.has(m.articleLegacyId) && m.mediaId !== undefined).map((m) => String(m.mediaId)));
  const mediaToDelete: (number | string)[] = [];
  const seen = new Set<string>();
  for (const m of media) {
    if (!deletedLegacy.has(m.articleLegacyId) || m.mediaId === undefined || seen.has(String(m.mediaId))) continue;
    seen.add(String(m.mediaId));
    if (m.origin !== "created") {
      rep.mediaKeptAdopted++;
      continue;
    }
    if (survivingRefs.has(String(m.mediaId))) {
      rep.mediaKeptReferenced++;
      continue;
    }
    const refs = await findAll(payload, "articles", { and: [{ tenant: { equals: tenantId } }, { heroImage: { equals: m.mediaId } }] }, { draft: true });
    if (refs.some((r) => !deleting.has(String(r.id)))) {
      rep.mediaKeptReferenced++;
      continue;
    }
    mediaToDelete.push(m.mediaId);
  }

  if (a.apply) {
    for (const id of deleteIds) {
      try {
        await pDelete(payload, "articles", id, { context: ctx });
        if (rep.orphans.some((o) => o.startsWith(`${String(id)} `))) rep.orphansDeleted++;
        else rep.deleted++;
      } catch (err) {
        const msg = String((err as Error).message);
        if (/translation_jobs|foreign key|violates/i.test(msg)) {
          await pUpdate(payload, "articles", id, { workflowStatus: "archived" }, { context: { ...ctx, systemWrite: true } });
          rep.archivedFallback.push(String(id));
        } else rep.errors.push(`${String(id)}: ${msg.slice(0, 200)}`);
      }
    }
    for (const id of mediaToDelete) {
      try {
        await pDelete(payload, "media", id, { context: ctx });
        rep.mediaDeleted++;
      } catch (err) {
        rep.errors.push(`media ${String(id)}: ${String((err as Error).message).slice(0, 200)}`);
      }
    }
    for (const t of state?.tagsCreated ?? []) {
      const used = await findAll(payload, "articles", { and: [{ tenant: { equals: tenantId } }, { tags: { contains: t.id } }] }, { draft: true });
      if (used.length) continue;
      try {
        await pDelete(payload, "tags", t.id, { context: ctx });
        rep.tagsDeleted++;
      } catch (err) {
        rep.errors.push(`tag ${t.slug}: ${String((err as Error).message).slice(0, 200)}`);
      }
    }
  }
  run.writeJson(`rollback-report${a.apply ? "" : "-dry"}.json`, rep);
  console.log(
    `[rollback] ${rep.mode.toUpperCase()} run ${runId}: entries ${rep.entries}; ${a.apply ? "deleted" : "would delete"} ${a.apply ? rep.deleted : rep.toDelete.length}; kept edited ${rep.keptEdited.length}; kept not-marker ${rep.keptNotMarker.length}; already gone ${rep.alreadyGone.length}; orphans ${rep.orphans.length}${a.apply ? ` (deleted ${rep.orphansDeleted})` : ""}; media ${a.apply ? `deleted ${rep.mediaDeleted}` : `would delete ${mediaToDelete.length}`}, kept referenced ${rep.mediaKeptReferenced}, kept adopted ${rep.mediaKeptAdopted}; tags deleted ${rep.tagsDeleted}; archived fallback ${rep.archivedFallback.length}; errors ${rep.errors.length}`,
  );
  for (const o of rep.orphans) console.log(`[rollback] orphan: ${o}`);
  return rep.errors.length ? 2 : 0;
}

runMain("rollback", main);
