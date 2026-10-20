/**
 * VowAsia VERIFY (Amendment 4 §4.4 item 12, B-12; OB10). READ-ONLY on Central.
 *
 *   npm run migrate:vowasia:verify -- --snapshot <dir> --runs-dir <dir> [--expect-sha256 <digest>] [--confirm-host=<host>]
 *
 * Compares Central (tenant vowasia, marker `legacy:vowasia`) with the snapshot plan:
 *  - every planned row exists (slug) and every marker article is in some run journal (slug-map complete);
 *  - status, pillar, sub-section and tag equal the plan; every article has an author of the pool;
 *  - every `upload` node and every hero image resolve to a Media of tenant vowasia; 0 pending upload nodes;
 *  - 0 references to the old image hosts in any body;
 *  - counts by status / pillar / tag (expected vs found).
 * Exit 0 = VERIFY OK, 3 = at least one mismatch (each printed), 2 = refusal.
 */
import { CliError, parseArgs, type FlagSpec } from "./args";
import { assertOutsideRepo } from "./assert-outside-repo";
import { verifySnapshotInput } from "./snapshot-vowasia-main";
import { resolvePath } from "./vowasia-cli";
import { oldHostsLeft, pendingUploadCount, uploadIds } from "./vowasia-body";
import { centralTarget } from "./vowasia-central";
import { checkTaxonomy, isMarker, loadTenantId, tenantArticles } from "./vowasia-central-state";
import { MediaStore } from "./vowasia-media";
import { buildPlan } from "./vowasia-plan";
import { findAll, relId, type Id } from "./vowasia-port";
import { allRuns } from "./vowasia-run";
import type { ImportDeps } from "./import-vowasia-main";

export const VERIFY_FLAGS: FlagSpec = { snapshot: "value", "runs-dir": "value", "expect-sha256": "value", "confirm-host": "value" };
const TOOL = "verify";

export async function runVerify(argv: readonly string[], deps: ImportDeps): Promise<number> {
  const a = parseArgs(argv, VERIFY_FLAGS);
  const log = deps.log;
  const snapArg = a.get("snapshot");
  const runsArg = a.get("runs-dir");
  if (!snapArg || !runsArg) throw new CliError(`${TOOL}: --snapshot and --runs-dir are required; refusing.`);
  centralTarget(deps.env, { confirmHost: a.get("confirm-host"), apply: false, isTty: deps.isTty, log, tool: TOOL });
  const snapDir = assertOutsideRepo(resolvePath(snapArg), deps.root, { create: false });
  const runsDir = assertOutsideRepo(resolvePath(runsArg), deps.root, { create: false });
  const expect = a.get("expect-sha256");
  const input = verifySnapshotInput(snapDir, { requireManifest: true, ...(expect ? { expectManifestSha256: expect } : {}) });
  const store = new MediaStore(snapDir, input.manifest!);
  const port = await deps.openPort();
  const problems: string[] = [];
  try {
    const tenantId = await loadTenantId(port);
    const tax = await checkTaxonomy(port, tenantId);
    const docs = await tenantArticles(port, tenantId);
    const plan = buildPlan(input, store, docs.filter((d) => !isMarker(d)).map((d) => ({ id: d.id as Id, slug: String(d.slug), marker: false })));
    const media = new Set((await findAll(port, "media", { tenant: { equals: tenantId } })).map((m) => String(m.id)));
    const name = (map: Map<string, Id>, id: unknown) => [...map.entries()].find(([, v]) => String(v) === relId(id))?.[0];
    const authorIds = new Set([...tax.authorId.values()].map(String));
    const bySlug = new Map(docs.filter(isMarker).map((d) => [String(d.slug), d]));
    const journaled = new Set<string>();
    for (const r of allRuns(runsDir)) for (const e of r.slugMap()) journaled.add(String(e.articleId));
    const exp = { status: {} as Record<string, number>, pillar: {} as Record<string, number>, tag: {} as Record<string, number> };
    const got = { status: {} as Record<string, number>, pillar: {} as Record<string, number>, tag: {} as Record<string, number> };
    const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
    for (const p of plan.importable) {
      bump(exp.status, p.finalStatus);
      bump(exp.pillar, p.pillar);
      bump(exp.tag, p.tag ?? "(no tag)");
      const d = bySlug.get(p.slug);
      if (!d) {
        problems.push(`${p.slug}: missing in Central`);
        continue;
      }
      const status = String(d.workflowStatus);
      const pillar = name(tax.pillarId, d.pillar);
      const sub = d.subSection ? [...tax.subId.entries()].find(([, v]) => String(v) === relId(d.subSection))?.[0] : undefined;
      const tags = Array.isArray(d.tags) ? (d.tags as unknown[]).map((t) => name(tax.tagId, t)) : [];
      bump(got.status, status);
      bump(got.pillar, pillar ?? "?");
      bump(got.tag, tags[0] ?? "(no tag)");
      if (status !== p.finalStatus) problems.push(`${p.slug}: status ${status}, planned ${p.finalStatus}`);
      if (pillar !== p.pillar) problems.push(`${p.slug}: pillar ${pillar ?? "?"}, planned ${p.pillar}`);
      if ((sub ?? null) !== (p.subSection ? `${p.pillar}/${p.subSection}` : null)) problems.push(`${p.slug}: sub-section ${sub ?? "none"}, planned ${p.subSection ?? "none"}`);
      if ((tags[0] ?? null) !== p.tag || tags.length > 1) problems.push(`${p.slug}: tags ${tags.join(",") || "none"}, planned ${p.tag ?? "none"}`);
      if (!authorIds.has(relId(d.author) ?? "")) problems.push(`${p.slug}: author missing or not one of the 6`);
      if (d.heroImage && !media.has(relId(d.heroImage) ?? "")) problems.push(`${p.slug}: hero image is not a tenant-vowasia Media`);
      if (pendingUploadCount(d.body)) problems.push(`${p.slug}: pending upload node(s)`);
      for (const id of uploadIds(d.body)) if (!media.has(id)) problems.push(`${p.slug}: upload node ${id} is not a tenant-vowasia Media`);
      if (oldHostsLeft(d.body, plan.imageHosts).length) problems.push(`${p.slug}: old image host left in the body`);
    }
    for (const d of bySlug.values()) if (!journaled.has(String(d.id))) problems.push(`${String(d.slug)}: marker article not in any run journal (slug-map incomplete)`);
    const kv = (m: Record<string, number>) => Object.entries(m).sort().map(([k, v]) => `${k} ${v}`).join(", ");
    log(`[${TOOL}] status expected: ${kv(exp.status)}; found: ${kv(got.status)}`);
    log(`[${TOOL}] pillar expected: ${kv(exp.pillar)}; found: ${kv(got.pillar)}`);
    log(`[${TOOL}] tag expected: ${kv(exp.tag)}; found: ${kv(got.tag)}`);
    log(`[${TOOL}] planned ${plan.importable.length}; marker articles in Central ${bySlug.size}; journaled ${journaled.size}`);
  } finally {
    await port.close?.();
  }
  for (const p of problems) log(`[${TOOL}] MISMATCH ${p}`);
  if (problems.length) {
    log(`[${TOOL}] VERIFY FAILED: ${problems.length} mismatch(es)`);
    return 3;
  }
  log(`[${TOOL}] VERIFY OK`);
  return 0;
}
