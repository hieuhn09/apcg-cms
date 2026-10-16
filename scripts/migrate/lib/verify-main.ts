/**
 * Implementation of `scripts/migrate/verify-gtp-parity.ts` (gtp-launch P4, 7.9
 * as superseded by A11-S10, A12-N05, A13-R02). Read-only on both sides.
 * Compares the legacy source (live or snapshot) with tenant `gtp` in Central
 * (Local API) and the run artifacts; optional public-API and gtp-web checks.
 * Exit 0 = every check PASS; exit 2 = at least one FAIL (listed).
 *
 *   npm run migrate:gtp:verify -- --run-id <id> --mapping-overlay <overlay> [--mapping path] [--from-snapshot dir]
 *     [--public-base <url>] [--base <gtp-web url>] [--confirm-host=<host>] [--require-final] [--rehearsal] [--out dir] [--batch 500]
 *   (read token: GTP_READ_TOKEN env; --read-token accepted with a warning)
 */
import "../../lib/env";
import path from "node:path";
import { getPayload } from "payload";
import config from "../../../payload.config";
import { pFind } from "../../lib/payload-loose";
import { CliError, intFlag } from "./args";
import { parseCommand, resolveMappingPath, resolveReadToken, resolveRequireFinal } from "./cli-spec";
import { assertImportTenant, centralTarget, loadEffectiveMapping, openLegacy, outDir, runMain } from "./cli-common";
import { expectedFromSource } from "./gtp-expected";
import { planEvents, toLegacyEvent, type CalendarRef } from "./gtp-events";
import { enText, isoOrNull, jaccard, plainTextForParity, sectionsToHtml, str } from "./gtp-transform";
import { blocks, nodeTypes } from "./lexical-body";
import { normaliseKey } from "./normalise-path";
import { writeFileSafe } from "./out-dir";
import { applyRewrittenLinks } from "./verify-parity-links";
import { RunDir, RunDirError, RUN_MESSAGES, allRunDirs, checkRunId } from "./run-dir";
import type { SlugPlanEntry } from "./slug-plan";

type Doc = Record<string, unknown>;
type P = Awaited<ReturnType<typeof getPayload>>;
const MARKER = { origin: "import", engineSourceName: "legacy:globaltravelpost" };

async function findAll(payload: P, collection: string, where: Doc, extra: Doc = {}): Promise<Doc[]> {
  const out: Doc[] = [];
  for (let page = 1; ; page++) {
    const r = (await pFind(payload, collection, { where, limit: 500, page, ...extra })) as unknown as { docs: Doc[]; hasNextPage?: boolean };
    out.push(...r.docs);
    if (!r.hasNextPage) return out;
  }
}
const relId = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : typeof v === "object" ? String((v as Doc).id) : String(v));

interface Check {
  id: string;
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string[];
}

async function main(): Promise<number> {
  const a = parseCommand("verify", process.argv.slice(2));
  const runIdRaw = a.get("run-id");
  if (!runIdRaw) throw new CliError("verify: --run-id is required.");
  const central = centralTarget(a, false);
  const tenantSlug = assertImportTenant();
  if (!a.get("mapping-overlay")) throw new CliError("verify: --mapping-overlay is required (site filter).");
  const v0 = loadEffectiveMapping(a, resolveMappingPath("verify", a), { structuralOnly: false });
  const publicBase = a.get("public-base");
  const publicBaseLocal = publicBase ? /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(`${publicBase.replace(/\/$/, "")}/`) : undefined;
  const rf = resolveRequireFinal("verify", a, { centralLocal: central.local, publicBaseLocal, siteFilter: v0.mapping.source.siteFilter });
  const v = rf.requireFinal ? loadEffectiveMapping(a, resolveMappingPath("verify", a), { structuralOnly: false, requireFinal: true }) : v0;
  const tok = resolveReadToken(a, process.env);
  if (tok.warning) console.warn(tok.warning);
  const m = v.mapping;
  const siteId = m.source.siteFilter as string;
  const run = new RunDir(path.join(outDir(a), checkRunId(runIdRaw)));
  if (!run.exists()) throw new RunDirError(RUN_MESSAGES.missing);
  const slugMap = run.slugMap();
  const plan = run.readJson<SlugPlanEntry[]>("slug-plan.json", []);
  const media = run.mediaMap();
  const checks: Check[] = [];
  const add = (id: string, name: string, fails: string[], skip?: string) =>
    checks.push({ id, name, status: skip ? "SKIP" : fails.length ? "FAIL" : "PASS", detail: skip ? [skip] : fails.slice(0, 25) });

  // Page size of the legacy read (default 500). The result must not depend on it (Amendment 5).
  const batch = intFlag(a, "batch", 500) as number;
  const reader = await openLegacy(a, v, siteId);
  const src: Doc[] = [];
  for await (const p of reader.pages("articles", ["id", "slug", "title", "status", "section", "subsection", "body_sections", "featured_image", "source_url", "published_at", "byline"], batch)) src.push(...p);
  const eventsSrc: Doc[] = [];
  for await (const p of reader.pages("events", "all", batch)) eventsSrc.push(...p);
  await reader.close();
  const exp = expectedFromSource(src, m);

  const payload = await getPayload({ config });
  const tenant = ((await pFind(payload, "tenants", { where: { slug: { equals: tenantSlug } }, limit: 1 })) as unknown as { docs: Doc[] }).docs[0];
  if (!tenant) throw new CliError(`verify: tenant ${tenantSlug} not found.`);
  const tenantId = tenant.id as number | string;
  const markerRows = await findAll(payload, "articles", { and: [{ tenant: { equals: tenantId } }, { origin: { equals: MARKER.origin } }, { engineSourceName: { equals: MARKER.engineSourceName } }] }, { draft: true, depth: 0 });
  // Event listings created by ANY run in this out dir (a second run skips the events of the first; Amendment 5).
  const eventIds = new Set([run, ...allRunDirs(outDir(a))].flatMap((r) => r.slugMap()).filter((e) => e.kind === "event").map((e) => String(e.articleId)));
  const art = markerRows.filter((d) => !eventIds.has(String(d.id)));
  const ev = markerRows.filter((d) => eventIds.has(String(d.id)));
  const pillars = new Map((await findAll(payload, "pillars", { tenant: { equals: tenantId } })).map((p) => [String(p.id), String(p.slug)]));
  const subs = new Map((await findAll(payload, "subsections", { tenant: { equals: tenantId } })).map((s) => [String(s.id), String(s.slug)]));
  const bySlug = new Map(art.map((d) => [String(d.slug), d]));
  const entryByLegacy = new Map(slugMap.map((e) => [e.legacyId, e]));
  const oldToNew = new Map(slugMap.filter((e) => e.oldUrl && e.status === "published").map((e) => [normaliseKey(e.oldUrl as string) ?? "", `/article/${e.slug}`]));

  // 1 counts by status
  {
    const got: Record<string, number> = {};
    for (const d of art) got[String(d.workflowStatus)] = (got[String(d.workflowStatus)] ?? 0) + 1;
    const fails: string[] = [];
    for (const k of new Set([...Object.keys(exp.byStatus), ...Object.keys(got)])) if ((exp.byStatus[k] ?? 0) !== (got[k] ?? 0)) fails.push(`${k}: expected ${exp.byStatus[k] ?? 0}, Central ${got[k] ?? 0}`);
    const totalSrc = src.length;
    const imported = Object.values(got).reduce((s, n) => s + n, 0);
    if (totalSrc - imported !== exp.rejected.length) fails.push(`source ${totalSrc} - imported ${imported} != rejects ${exp.rejected.length}`);
    add("1", "counts by status", fails);
  }
  // 2 per pillar / sub-section (independent recomputation)
  {
    const got: Record<string, number> = {};
    for (const d of art) {
      const k = `${pillars.get(relId(d.pillar) ?? "") ?? "?"}/${subs.get(relId(d.subSection) ?? "") ?? ""}`;
      got[k] = (got[k] ?? 0) + 1;
    }
    const fails: string[] = [];
    for (const k of new Set([...Object.keys(exp.bySub), ...Object.keys(got)])) if ((exp.bySub[k] ?? 0) !== (got[k] ?? 0)) fails.push(`${k}: expected ${exp.bySub[k] ?? 0}, Central ${got[k] ?? 0}`);
    add("2", "counts per pillar/sub-section", fails);
  }
  // 3 slug set diff
  {
    const expSlugs = new Set(plan.filter((p) => p.kind === "article").map((p) => p.slug));
    const fails: string[] = [];
    for (const s of expSlugs) if (!bySlug.has(s)) fails.push(`missing in Central: ${s}`);
    for (const s of bySlug.keys()) if (!expSlugs.has(s)) fails.push(`unexpected in Central: ${s}`);
    add("3", "slug set", fails);
  }
  // 4 + 5 body text and structure (stratified sample, max 100 + 20 longest)
  {
    const fails: string[] = [];
    const strata = new Map<string, Doc[]>();
    for (const r of src) {
      if (!entryByLegacy.has(String(r.id))) continue;
      const k = `${str(r.status)}|${str(r.section)}`;
      strata.set(k, [...(strata.get(k) ?? []), r]);
    }
    // Every imported row when the population is small enough (fixture 300, real 1,637); else a stratified sample of 100.
    const importedRows = src.filter((r) => entryByLegacy.has(String(r.id)));
    const sample: Doc[] = importedRows.length <= 2000 ? importedRows : [];
    for (let i = 0; importedRows.length > 2000 && sample.length < 100; i++) {
      let added = false;
      for (const list of strata.values()) if (list[i] && sample.length < 100) {
        sample.push(list[i] as Doc);
        added = true;
      }
      if (!added) break;
    }
    const longest = [...src].filter((r) => entryByLegacy.has(String(r.id))).sort((x, y) => JSON.stringify(y.body_sections ?? "").length - JSON.stringify(x.body_sections ?? "").length).slice(0, 20);
    for (const r of new Set([...sample, ...longest])) {
      const e = entryByLegacy.get(String(r.id));
      const d = e ? bySlug.get(e.slug) : undefined;
      if (!d) {
        fails.push(`no Central row for ${String(r.id)}`);
        continue;
      }
      const s = sectionsToHtml(r.body_sections);
      // Pass 2 (rewrite-links) legitimately replaced old-site URLs with /article/<slug>: apply the same mapping to the source text.
      const srcText = applyRewrittenLinks(s.text, blocks(d.body).map((b) => b.text).join("\n"), e?.textLinks ?? [], oldToNew);
      const a1 = plainTextForParity(srcText);
      const b1 = plainTextForParity(blocks(d.body).map((b) => b.text).join("\n"));
      const ratio = a1.length ? b1.length / a1.length : b1.length ? 9 : 1;
      const sim = jaccard(a1, b1);
      if (ratio < 0.9 || ratio > 1.1 || sim < 0.97) fails.push(`${String(r.id)} body ratio ${ratio.toFixed(3)} similarity ${sim.toFixed(3)}`);
      const headings = blocks(d.body).filter((b) => b.type === "heading").length;
      if (headings !== s.headings.length) fails.push(`${String(r.id)} headings ${s.headings.length} vs ${headings}`);
      const types = nodeTypes(d.body);
      for (const t of types) if (!["root", "paragraph", "heading", "text"].includes(t)) fails.push(`${String(r.id)} unexpected node type ${t}`);
    }
    add("4", importedRows.length <= 2000 ? "body text parity (all imported rows)" : "body text parity (sample)", fails.filter((f) => !f.includes("headings") && !f.includes("node type")));
    add("5", "body structure (headings, node types)", fails.filter((f) => f.includes("headings") || f.includes("node type")));
  }
  // 6 relationships
  {
    const fails: string[] = [];
    const heroOk = new Set(media.filter((x) => (x.origin === "created" || x.origin === "adopted") && x.mediaId !== undefined).map((x) => x.articleLegacyId));
    for (const r of src) {
      const e = entryByLegacy.get(String(r.id));
      if (!e || e.kind !== "article") continue;
      const d = bySlug.get(e.slug);
      if (!d) continue;
      if (!relId(d.author)) fails.push(`${e.slug}: no author`);
      if (!relId(d.pillar)) fails.push(`${e.slug}: no pillar`);
      if (str(r.featured_image) && heroOk.has(e.legacyId) && !relId(d.heroImage)) fails.push(`${e.slug}: hero expected`);
    }
    add("6", "relationships (author, pillar, hero)", fails);
  }
  // 7 image reachability
  {
    const fails: string[] = [];
    const ids = new Set(art.map((d) => relId(d.heroImage)).filter(Boolean) as string[]);
    const docs = ids.size ? await findAll(payload, "media", { and: [{ tenant: { equals: tenantId } }, { id: { in: [...ids] } }] }) : [];
    if (docs.length !== ids.size) fails.push(`hero media docs ${docs.length} of ${ids.size}`);
    for (const d of docs) if (!/^image\//.test(String(d.mimeType ?? ""))) fails.push(`media ${String(d.id)} mime ${String(d.mimeType)}`);
    if (publicBase && docs.length) {
      for (const d of docs.slice(0, 10)) {
        const url = new URL(String(d.url), publicBase).toString();
        const res = await fetch(url, { method: "GET", redirect: "manual" }).catch(() => undefined);
        await res?.body?.cancel().catch(() => {});
        if (!res || res.status !== 200 || !/^image\//.test(res.headers.get("content-type") ?? "")) fails.push(`GET ${String(d.filename)} -> ${res?.status ?? "error"}`);
      }
    }
    add("7", "image reachability", fails);
  }
  // 8 redirects
  {
    const red = run.readJson<{ rules: { from: string; to: string | null; status: number }[] } | null>("redirects.json", null);
    if (!red) add("8", "redirects", [], "redirects.json not built for this run");
    else {
      const fails: string[] = [];
      const map = new Map(red.rules.map((r) => [r.from, r]));
      for (const e of slugMap) {
        if (e.kind !== "article" || e.status !== "published" || !e.oldUrl) continue;
        const k = normaliseKey(e.oldUrl);
        if (!k) {
          fails.push(`${e.legacyId}: unconverged key`);
          continue;
        }
        if (k === `/article/${e.slug}`) continue;
        const r = map.get(k);
        if (!r) fails.push(`${e.legacyId}: no rule for ${k}`);
        else if (r.to && r.to.startsWith("/article/") && !bySlug.has(r.to.slice(9))) fails.push(`${k} -> ${r.to}: target missing`);
        else if (r.to && map.has(r.to)) fails.push(`${k}: chain`);
      }
      add("8", "redirects resolve (one hop, existing targets)", fails);
    }
  }
  // 9 public visibility: Local API predicate of the public route, plus the public API when given
  {
    const fails: string[] = [];
    for (const d of art) {
      const visible = d.workflowStatus === "published";
      const e = slugMap.find((x) => String(x.articleId) === String(d.id));
      if (e && e.status !== "published" && visible) fails.push(`${String(d.slug)}: ${e.status} row is public`);
      if (e && e.status === "published" && !visible) fails.push(`${String(d.slug)}: published row not public`);
    }
    if (publicBase) {
      if (!tok.token) throw new CliError("verify: --public-base needs GTP_READ_TOKEN.");
      const headers = { authorization: `Bearer ${tok.token}` };
      const published = art.filter((d) => d.workflowStatus === "published");
      const nonPublic = art.filter((d) => d.workflowStatus !== "published");
      for (const d of [...published.slice(0, 15), ...nonPublic.slice(0, 15)]) {
        const res = await fetch(new URL(`/api/public/articles/${encodeURIComponent(String(d.slug))}`, publicBase), { headers }).catch(() => undefined);
        const want = d.workflowStatus === "published" ? 200 : 404;
        if (!res || res.status !== want) fails.push(`public ${String(d.slug)} (${String(d.workflowStatus)}): ${res?.status ?? "error"} expected ${want}`);
        await res?.body?.cancel().catch(() => {});
      }
      for (const [pid, pslug] of pillars) {
        const expectN = published.filter((d) => relId(d.pillar) === pid).length + ev.filter((d) => d.workflowStatus === "published" && relId(d.pillar) === pid).length;
        const res = await fetch(new URL(`/api/public/articles?pillar=${encodeURIComponent(pslug)}&limit=1`, publicBase), { headers }).catch(() => undefined);
        const body = res && res.ok ? ((await res.json()) as { totalDocs?: number }) : undefined;
        if (body?.totalDocs !== undefined && body.totalDocs < expectN) fails.push(`public pillar ${pslug}: totalDocs ${body.totalDocs} < imported published ${expectN}`);
      }
    }
    add("9", `public visibility${publicBase ? " (Local API predicate + public API)" : " (Local API predicate of the public route)"}`, fails);
  }
  // 10 single-home
  {
    const pr = [...pillars.entries()].find(([, s]) => s === "press-room")?.[0];
    const fails = art.filter((d) => relId(d.pillar) === pr && (relId(d.subSection) || (Array.isArray(d.secondarySections) && d.secondarySections.length) || d.exclusive === true)).map((d) => String(d.slug));
    add("10", "single-home (press-room)", fails);
  }
  // 11 provenance and marker
  {
    const fails: string[] = [];
    for (const r of src) {
      const e = entryByLegacy.get(String(r.id));
      if (!e) continue;
      const d = bySlug.get(e.slug);
      if (!d) continue;
      const su = typeof r.source_url === "string" && r.source_url !== "" ? r.source_url : undefined;
      if (su ? d.engineSourceUrl !== su : d.engineSourceUrl !== undefined && d.engineSourceUrl !== null && d.engineSourceUrl !== "") fails.push(`${e.slug}: engineSourceUrl mismatch`);
    }
    for (const d of markerRows) if (d.editedByHuman !== true) fails.push(`${String(d.slug)}: editedByHuman not true`);
    add("11", "provenance (engineSourceUrl exact, marker, editedByHuman)", fails);
  }
  // events
  {
    const calendar: CalendarRef[] = src.filter((r) => str(r.section) === "events-awards" && str(r.subsection) === "industry-calendar").map((r) => ({ title: enText(r.title), date: isoOrNull(r.published_at)?.slice(0, 10) ?? null, legacyId: String(r.id) }));
    const ed = planEvents(eventsSrc.map(toLegacyEvent), calendar, m.events.nearMatchThreshold);
    const fails: string[] = [];
    if (m.events.enabled) {
      if (ev.length !== ed.imports.length) fails.push(`events expected ${ed.imports.length} (= ${eventsSrc.length} - ${ed.duplicates.length} duplicates - ${ed.near.length} near), Central ${ev.length}`);
      const arch = ev.filter((d) => d.workflowStatus === "archived").length;
      const expArch = ed.imports.filter((e) => !e.active).length;
      if (arch !== expArch) fails.push(`archived events ${arch} expected ${expArch}`);
      for (const d of ev) {
        const b = Array.isArray(d.briefs) ? (d.briefs as Doc[]) : [];
        if (b.length > 4 || b.some((x) => !str(x.label) || !str(x.value) || !str(x.source))) fails.push(`${String(d.slug)}: bad briefs`);
      }
    }
    add("E", "events (imported = total - duplicates - near; inactive archived; briefs shape)", fails);
  }
  // 12 PII scan of the report itself (below)
  const lines = [`# GTP parity report (run ${run.dir.split("/").pop()})`, "", `- Central: ${central.banner}; tenant ${tenantSlug}; marker rows ${markerRows.length} (articles ${art.length}, events ${ev.length})`, ""];
  for (const c of checks) {
    lines.push(`## ${c.id} ${c.name}: ${c.status}`);
    for (const d of c.detail) lines.push(`- ${d}`);
    lines.push("");
  }
  const text = lines.join("\n");
  const pii = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text);
  checks.push({ id: "12", name: "PII scan of this report", status: pii ? "FAIL" : "PASS", detail: [] });
  writeFileSafe(run.p("parity-report.md"), text + `\n## 12 PII scan of this report: ${pii ? "FAIL" : "PASS"}\n`);
  const failed = checks.filter((c) => c.status === "FAIL");
  for (const c of checks) console.log(`[verify] ${c.id.padStart(2)} ${c.status.padEnd(4)} ${c.name}${c.status === "FAIL" ? `: ${c.detail.slice(0, 3).join("; ")}` : c.status === "SKIP" ? ` (${c.detail[0]})` : ""}`);
  console.log(`[verify] ${failed.length ? `FAIL (${failed.length} checks)` : "PASS"}`);
  return failed.length ? 2 : 0;
}

runMain("verify", main);
