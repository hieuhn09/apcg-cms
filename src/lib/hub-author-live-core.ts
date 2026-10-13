/**
 * Hub LIVE edit (APCGHub P5.4, "Sửa bài đã đăng") — `PATCH /api/hub/articles/{id}/live`:
 * save an edit of a PUBLISHED, hub-authored article straight onto the live row (no
 * draft, no `pending_review`). Content-engine plan
 * process/features/apcg-hub/active/apcg-hub-p5-4-edit-published_PLAN_30-09-26.md
 * (D1–D16, §4.1 step 4, T1/T2).
 *
 * Check order (first failure wins):
 *   auth = token + `hubRead` + `hubWrite` (`authenticateHubWriteEngine`; 401 / 403)
 *   → an engine that ALSO carries `hubAuthor` ⇒ 403 "author key cannot live-edit" (D14)
 *   → body ≤ 1,000,000 bytes (413) / JSON (400) → `parseLiveBody` (400 structure,
 *     422 not_live_editable for a locked key, then the PATCH parser's 400 / 422)
 *   → tenant ∈ grant + `features.articles` (403, `resolveTenant`)
 *   → tenant ∈ `HUB_LIVE_EDIT_TENANTS` (403 feature_disabled "live edit disabled for
 *     tenant", BEFORE any article read — D11)
 *   → id shape + int4 (404) → gate 1 (D2: latest + FULL main of THAT tenant, 404; 422
 *     not_live_editable origin | scheduled | status | not_hub_authored; 409 draft_diverged)
 *     → `expectedVersion` === main.version (409 version_conflict)
 *   → `buildDraftUpdateData` (the PATCH pipeline: round-trip ⇒ 422 body_not_editable,
 *     refs, merge rules, conversion + body media, the field map) → D5 (body images ⊆ the
 *     upload nodes already in the live body, else 422 `fields.bodyMarkdown: unknown_ref`)
 *     → nothing changed ⇒ 200 `changed: []`, NO write → `checkPublishable` on the merged
 *     result (422 invalid)
 *   → `withHubArticleLock` (advisory lock, ONE transaction; busy ⇒ 503) and inside it:
 *     `lockRow` = `SELECT 1 FROM articles WHERE id = $1 FOR NO KEY UPDATE` on the
 *     transaction's session (D16) → gate 2 + `expectedVersion` again → `pre` (D12) →
 *     `beforeWrite?` (D15, test seam only) → the write (D1) → `post` + latest → D12 ⇒
 *     rollback + 409 draft_diverged → 200 `{ok, id, tenant, workflowStatus, version, changed}`
 *     with `version` re-read in the transaction (never `updated.version`).
 *
 * D1 — the write: a NON-draft `payload.update` on the transaction's `req`, `locale: "en"`,
 * with ONLY the changed fields (never `workflowStatus` / `_status` / `publishedAt`, so a
 * Hide that slipped in is kept and caught by D12) and `context.hubAuthor` (NOT
 * `context.hubWrite`): `articleBookkeeping` bumps `version`, marks translations outdated
 * and leaves `lastEngine` / `editedByHuman` / `origin` alone; `articleActivity` writes one
 * `human_edit` row; the revalidate webhook fires (no `disableRevalidate`).
 *
 * Logs: an error NAME / CODE and field NAMES only — never content or a token. The exported
 * route wrapper never passes `deps`; `handleHubLiveUpdateWith(…, deps)` is for unit checks.
 */

import { getPayload, type Payload, type PayloadRequest } from "payload";
import config from "@payload-config";
import { sql } from "@payloadcms/db-postgres";
import { isHubArticleId } from "@/lib/hub-article-id";
import { loadHubEditorConfig } from "@/lib/hub-article-markdown";
import { json } from "@/lib/http";
import { toId } from "@/access/helpers";
import { featureEnabled, supportedLanguages, type TenantDoc } from "@/lib/tenant";
import { authenticateHubWriteEngine } from "@/lib/hub-write-auth";
import { isHubAuthoredDoc } from "@/lib/hub-author-auth";
import type { ConvertResult, HubEditorConfig } from "@/lib/hub-author-body";
import { extractMediaIds, uploadIdsInTree } from "@/lib/hub-author-media-token";
import type { HubDraftFieldKey, HubDraftInput } from "@/lib/hub-author-input";
import { checkPublishable } from "@/lib/hub-author-publish-core";
import { withHubArticleLock, type HubLockCtx, type HubLockResult } from "@/lib/hub-article-lock";
import {
  buildDraftUpdateData,
  defaultFindMain,
  invalid,
  logInternal,
  notFound,
  parsedResponse,
  readBody,
  resolveTenant,
  versionConflict,
  writeFailed,
} from "@/lib/hub-author-handlers";
import {
  HUB_LIVE_EDITABLE_FLAGS,
  HUB_LIVE_FIELD_KEYS,
  isLiveFieldKey,
  liveEditTenants,
  liveGateReason,
  livePostWriteCheck,
  parseLiveBody,
  type HubLiveFieldKey,
  type HubLiveGateReason,
} from "@/lib/hub-author-live-pure";

export { HUB_LIVE_FIELD_KEYS };

const SCOPE = "hub/articles/live";

type Doc = Record<string, unknown>;
type Id = number | string;

/**
 * D12 (CMS3-1): the stored column(s) of every live key — the columns `buildDraftUpdateData`
 * writes for it. `flags` lists the two editable flag columns; only the flags actually SENT
 * are left out of the post-write comparison.
 */
export const LIVE_KEY_COLUMNS: Record<HubLiveFieldKey, readonly string[]> = {
  title: ["title"],
  dek: ["dek"],
  bodyMarkdown: ["body"],
  takeaways: ["takeaways"],
  readMin: ["readMin"],
  pillarSlug: ["pillar"],
  subSectionSlug: ["subSection"],
  secondary: ["secondarySections"],
  tagSlugs: ["tags"],
  countrySlugs: ["countries", "country"],
  citySlugs: ["cities"],
  authorId: ["author"],
  coAuthorIds: ["coAuthors"],
  flags: HUB_LIVE_EDITABLE_FLAGS,
  sponsor: ["sponsor"],
};

/** The columns left out of D12 (1) for this write: the mapped columns of every CHANGED key. */
export function liveChangedColumns(changed: readonly HubDraftFieldKey[], v: Pick<HubDraftInput, "flags">): string[] {
  const out: string[] = [];
  for (const k of changed) {
    if (!isLiveFieldKey(k)) continue;
    if (k === "flags") {
      for (const f of Object.keys(v.flags ?? {})) if ((HUB_LIVE_EDITABLE_FLAGS as readonly string[]).includes(f)) out.push(f);
      continue;
    }
    out.push(...LIVE_KEY_COLUMNS[k]);
  }
  return out;
}

// ── Response bodies (T2) ─────────────────────────────────────────────────────

const notLiveEditable = (reason: HubLiveGateReason) => json({ ok: false, status: "not_live_editable", reason }, 422);
const draftDiverged = () => json({ ok: false, status: "draft_diverged", reason: "article has unpublished changes" }, 409);
const liveFeatureDisabled = () => json({ ok: false, status: "feature_disabled", reason: "live edit disabled for tenant" }, 403);
const authorKeyRefused = () => json({ ok: false, status: "forbidden", reason: "author key cannot live-edit" }, 403);

// ── Seams ────────────────────────────────────────────────────────────────────

interface Executor {
  execute: (q: unknown) => Promise<unknown>;
}

/** D12 / D1 (iii): a main-row read on the TRANSACTION (`req`), depth 0. */
export type FindMainTx = (payload: Payload, id: Id, req: PayloadRequest | undefined, o?: { locale?: string }) => Promise<Doc | null>;

export const defaultFindMainTx: FindMainTx = async (payload, id, req, o) =>
  (await payload.findByID({
    collection: "articles",
    id,
    req,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
    ...(o?.locale ? { locale: o.locale as never } : {}),
  })) as unknown as Doc | null;

/** D12: the ONE read shape of `pre` and `post` — every locale, depth 0, in the transaction. */
export function readMainAll(payload: Payload, id: Id, req: PayloadRequest | undefined, findMainTx: FindMainTx = defaultFindMainTx): Promise<Doc | null> {
  return findMainTx(payload, id, req, { locale: "all" });
}

/**
 * D16: `SELECT 1 FROM articles WHERE id = $1 FOR NO KEY UPDATE` on the transaction's own
 * session (the way `hub-article-lock.ts` runs raw SQL). No session ⇒ throw (⇒ 500, no write).
 * NO KEY: blocks every `UPDATE articles` of this row (Hide / Republish / Publish / intake /
 * crons) but not an INSERT with a foreign key to it (`_articles_v`, `translation_jobs`).
 */
export async function defaultLockRow(payload: Payload, id: Id, req: PayloadRequest | undefined): Promise<void> {
  const adapter = payload.db as unknown as { sessions?: Record<string, { db?: Executor } | undefined> };
  const txId = req?.transactionID;
  const exec = txId != null ? adapter.sessions?.[String(txId)]?.db : undefined;
  if (!exec) throw new Error("hub live: no transaction session for the row lock");
  await exec.execute(sql`SELECT 1 FROM articles WHERE id = ${Number(id)} FOR NO KEY UPDATE`);
}

/** Injectable seams (unit checks / the in-process probe only; production never passes them). */
export interface HubLiveDeps {
  authenticate?: typeof authenticateHubWriteEngine;
  getPayload?: () => Promise<Payload>;
  lock?: typeof withHubArticleLock;
  /** The gate's FULL main read (default `defaultFindMain`, no select). */
  findMain?: (payload: Payload, id: Id) => Promise<Doc | null>;
  /** Reads on the transaction (`pre`, `post`, the returned version). */
  findMainTx?: FindMainTx;
  /** D16 (default `defaultLockRow`). */
  lockRow?: (payload: Payload, id: Id, req: PayloadRequest | undefined) => Promise<void>;
  /** D11 (default: `liveEditTenants()` read from the env on this call). */
  liveTenants?: readonly string[];
  /** D15: called in the lock right before the write, after every read of gate 2. */
  beforeWrite?: () => Promise<void>;
  convert?: (payload: Payload, md: string) => Promise<ConvertResult>;
}

const defaultGetPayload = () => getPayload({ config });

// ── Gate (D2) ────────────────────────────────────────────────────────────────

type GateOk = { ok: true; main: Doc; latest: Doc };
type GateFail = { ok: false; response: Response };

/** latest (draft) + FULL main of THIS tenant (404) → `liveGateReason`. `req` = the transaction (gate 2) or none (gate 1). */
async function readGate(
  payload: Payload,
  articleId: number,
  tenant: { id: Id },
  findMain: (payload: Payload, id: Id) => Promise<Doc | null>,
  req?: PayloadRequest,
): Promise<GateOk | GateFail> {
  const latest = (await payload.findByID({
    collection: "articles",
    id: articleId,
    draft: true,
    depth: 0,
    locale: "en",
    overrideAccess: true,
    disableErrors: true,
    ...(req ? { req } : {}),
  })) as unknown as Doc | null;
  if (!latest || String(toId(latest.tenant)) !== String(tenant.id)) return { ok: false, response: notFound() };
  const main = await findMain(payload, articleId);
  if (!main || String(toId(main.tenant)) !== String(tenant.id)) return { ok: false, response: notFound() };
  const reason = liveGateReason({ main, latest, isHubAuthored: await isHubAuthoredDoc(payload, latest) });
  if (reason === "draft_diverged") return { ok: false, response: draftDiverged() };
  if (reason) return { ok: false, response: notLiveEditable(reason) };
  return { ok: true, main, latest };
}

const versionOf = (d: Doc): number => (typeof d.version === "number" ? d.version : 0);

/** D5: every `cms-media:<id>` of the new body must already be an upload node of the LIVE body. */
export function liveBodyMediaAllowed(bodyMarkdown: string, liveBody: unknown): boolean {
  const allowed = new Set(uploadIdsInTree(liveBody));
  return extractMediaIds(bodyMarkdown).every((i) => allowed.has(i));
}

/** D12 (3): the tenant re-queues translations for this article (same expression as `enqueueTranslations`). */
export function liveTranslationsActive(tenant: TenantDoc, post: Doc): boolean {
  const source = (post.sourceLanguage as string) || tenant.defaultLanguage;
  return featureEnabled(tenant, "translations") && supportedLanguages(tenant).some((l) => l !== source);
}

// ── Handler ──────────────────────────────────────────────────────────────────

export function handleHubLiveUpdate(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleHubLiveUpdateWith(request, ctx);
}

export async function handleHubLiveUpdateWith(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
  deps?: HubLiveDeps,
): Promise<Response> {
  const { id } = await ctx.params;
  const payload = await (deps?.getPayload ?? defaultGetPayload)();
  const auth = await (deps?.authenticate ?? authenticateHubWriteEngine)({ payload, request });
  if (!auth.ok) return auth.response;
  const engine = auth.engine as { id: Id; hubAuthor?: boolean | null };
  // D14: defence in depth — the author key never edits a live article, even with hubWrite.
  if (engine.hubAuthor === true) return authorKeyRefused();
  const findMain = deps?.findMain ?? defaultFindMain;
  const findMainTx = deps?.findMainTx ?? defaultFindMainTx;

  try {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const parsed = parseLiveBody(body.raw);
    if (!parsed.ok) return parsedResponse(parsed);
    const v = parsed.value;

    const t = await resolveTenant(payload, auth, v.tenant);
    if (!t.ok) return t.response;
    const tenant = t.tenant;
    // D11: the CMS switch, before the first article read.
    const liveTenants = deps?.liveTenants ?? liveEditTenants();
    if (!liveTenants.includes(tenant.slug)) return liveFeatureDisabled();

    if (!isHubArticleId(id)) return notFound();
    const articleId = Number(id);

    // Gate 1 (D2) + expectedVersion.
    const g1 = await readGate(payload, articleId, tenant, findMain);
    if (!g1.ok) return g1.response;
    const { main, latest } = g1;
    const mainVersion = versionOf(main);
    if (v.expectedVersion !== mainVersion) return versionConflict(mainVersion);

    // D3: the PATCH pipeline, unchanged.
    const built = await buildDraftUpdateData(payload, {
      v,
      tenant,
      latest,
      editorConfig: async () => (await loadHubEditorConfig(payload.config)) as HubEditorConfig,
      deps: { convert: deps?.convert },
    });
    if (!built.ok) return built.response;
    const { data, changed } = built;

    // D5: no new image on a live article.
    if (v.bodyMarkdown !== undefined && !liveBodyMediaAllowed(v.bodyMarkdown, main.body)) return invalid({ bodyMarkdown: "unknown_ref" });

    if (changed.length === 0) {
      return json({ ok: true, id: articleId, tenant: tenant.slug, workflowStatus: "published", version: mainVersion, changed: [] }, 200);
    }

    // The publish rules on the merged result (P5.2 `checkPublishable`).
    const fields = await checkPublishable({ payload, tenant: { id: tenant.id, slug: tenant.slug }, latest: { ...latest, ...data } });
    if (Object.keys(fields).length) return invalid(fields);

    return await (deps?.lock ?? withHubArticleLock)({ tenantId: tenant.id, articleId }, (lk) =>
      inLock(lk, { v, tenant, articleId, data, changed }),
    );
  } catch (err) {
    return logInternal(payload, engine.id, err);
  }

  async function inLock(
    lk: HubLockCtx,
    s: { v: HubDraftInput; tenant: TenantDoc; articleId: number; data: Doc; changed: HubDraftFieldKey[] },
  ): Promise<HubLockResult> {
    const { v, tenant, articleId, data, changed } = s;
    const fail = (value: Response): HubLockResult => ({ ok: false, value });
    // D16: the row lock BEFORE any read of gate 2.
    await (deps?.lockRow ?? defaultLockRow)(payload, articleId, lk.req);
    const g2 = await readGate(payload, articleId, tenant, findMain, lk.req);
    if (!g2.ok) return fail(g2.response);
    const currentVersion = versionOf(g2.main);
    if (v.expectedVersion !== currentVersion) return fail(versionConflict(currentVersion));

    // D12: `pre`, right after gate 2, before the seam and the write.
    const pre = await readMainAll(payload, articleId, lk.req, findMainTx);
    if (!pre) return fail(notFound());
    if (deps?.beforeWrite) await deps.beforeWrite();

    try {
      // D1: non-draft, changed fields only, `context.hubAuthor` (never hubWrite / disableRevalidate).
      await payload.update({
        collection: "articles",
        id: articleId,
        req: lk.req,
        locale: "en",
        data: { ...data } as never,
        depth: 0,
        overrideAccess: true,
        context: { hubAuthor: { actor: v.actor, action: "update", fields: changed }, engineId: engine.id },
      });
    } catch (err) {
      return fail(await writeFailed(payload, engine.id, tenant.id, undefined, err, articleId));
    }

    // D12: the post-write assertion, on the SAME transaction.
    const post = await readMainAll(payload, articleId, lk.req, findMainTx);
    const latestAfter = (await payload.findByID({
      collection: "articles",
      id: articleId,
      draft: true,
      depth: 0,
      locale: "en",
      overrideAccess: true,
      disableErrors: true,
      req: lk.req,
    })) as unknown as Doc | null;
    const check = livePostWriteCheck({
      pre,
      post,
      latest: latestAfter,
      changedColumns: liveChangedColumns(changed, v),
      currentVersion,
      translationsActive: post ? liveTranslationsActive(tenant, post) : false,
    });
    if (!check.ok) {
      payload.logger.warn(`[${SCOPE}] post-write check failed: article=${articleId} tenant=${tenant.slug} leg=${check.leg} keys=${check.detail.join(",")}`);
      return fail(draftDiverged());
    }
    // D1 (iii): the version is the one READ in the transaction, never `updated.version`.
    const version = versionOf(post as Doc);
    return {
      ok: true,
      value: json({ ok: true, id: articleId, tenant: tenant.slug, workflowStatus: "published", version, changed }, 200),
    };
  }
}
