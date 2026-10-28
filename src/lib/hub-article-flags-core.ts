/**
 * Hub FLAGS write — `POST /api/hub/articles/{id}/flags`: set "Độc quyền" (`exclusive`) and
 * "Ghim lên Mới nhất" (`pinnedToLatest` + `pinnedUntil`) on ONE PUBLISHED article of ANY origin
 * (hub, engine, an article an editor made in CMS admin), so neither flag needs CMS admin.
 * Content-engine plan process/features/apcg-hub/active/hub-pin-exclusive-flags_PLAN_28-10-26.md
 * (D6–D9, Public Contracts CMS 6 + 7).
 *
 * Check order (first failure wins):
 *   auth = token + `hubRead` + `hubWrite` (`authenticateHubWriteEngine`; 401 / 403)
 *   → an engine that ALSO carries `hubAuthor` ⇒ 403 "author key cannot change flags" (logged
 *     as `engine_action_denied`)
 *   → body ≤ 16,384 bytes (413, Content-Length then the stream) / JSON (400) → `parseFlagsBody` (400 structure / unknown
 *     keys; 422 field codes incl. the `pinnedUntil` window, now injectable)
 *   → tenant ∈ grant (403 + allowedTenants, logged) + `features.articles` (403)
 *   → tenant ∈ HUB_EDITORIAL_FLAGS_TENANTS (403 feature_disabled "editorial flags disabled
 *     for tenant", BEFORE any article read)
 *   → id shape + int4 (404) → an UNLOCKED tenant-only read: the article belongs to this
 *     tenant, else the same 404 (review L1: no lock is ever taken on another tenant's row)
 *   → `withHubArticleLock({tenantId, articleId})` (advisory lock, ONE transaction; busy ⇒ 503)
 *     and inside it: `FOR NO KEY UPDATE` on the row (`defaultLockRow`) → the LATEST version
 *     and the MAIN row of THAT tenant on the transaction (one 404 body) → D9 gate (422
 *     not_flaggable scheduled | status | legacy_status; 409 draft_diverged) → `expected` ≠
 *     the main row's values ⇒ 409 flags_conflict + `current` → nothing to change ⇒ 200
 *     `changed: []`, NO write → `pre` (main, every locale) → the write → `post` + latest →
 *     D8 (another column moved or the latest version diverged — e.g. a human Save Draft landed
 *     mid-flight — ⇒ rollback + 409 draft_diverged; our own value missing / not as asked ⇒
 *     rollback + 500; logged by leg + column NAMES) → COMMIT → 200 `{ok, id, tenant, exclusive,
 *     pinnedToLatest, pinnedUntil, changed}` with the values re-read in the transaction
 *   → AFTER the commit only: the one `human_edit` ActivityLog row and the revalidate webhook.
 *
 * D7 — the write: ONE non-draft `payload.update` on the transaction's `req`, in the article's
 * source language (`writeLocaleOf`; the three columns are not localized, but Payload validates
 * the required localized fields in the write locale), data = ONLY the changed columns, `overrideAccess`
 * (the `exclusive` field access is for human sessions; the hub's permission check is its own
 * `hubMayFlag`, the CMS records the hub-asserted actor), context `{hubFlags, engineId,
 * skipTranslationEnqueue: true, disableRevalidate: true}`: `articleBookkeeping` skips (no
 * `version` bump, no `lastEditedBy`), `articleActivity` writes nothing, no translation job, and
 * the collection's revalidate hook stays silent. After the COMMIT the route writes exactly ONE
 * `human_edit` row `{via:"hub", actor, action:"flags", fields, from, to}` and posts the SAME
 * signed webhook once (`revalidateTenantDoc`, tags `articles:all` + slug) — review M1 / L2: no
 * webhook from inside the open transaction (the frontend could re-cache the old row, and a slow
 * frontend held the locks), no phantom audit row after a rollback.
 *
 * Write errors: Payload `ValidationError` (e.g. single-home V6: a Pressroom article cannot be
 * `exclusive`) ⇒ 422 `fields.<path>: invalid`; 55P03 / 40P01 / 40001 ⇒ 503 busy; anything
 * else ⇒ 500 (logged by error NAME + CODE only). Logs never carry content or a token.
 * The exported route wrapper never passes `deps`; `handleHubFlagsWith(…, deps)` is for unit checks.
 */

import { getPayload, type Payload, type PayloadRequest } from "payload";
import config from "@payload-config";
import { isHubArticleId } from "@/lib/hub-article-id";
import { json } from "@/lib/http";
import { toId } from "@/access/helpers";
import { logActivity } from "@/lib/activity";
import { authenticateHubWriteEngine } from "@/lib/hub-write-auth";
import { busyResponse, withHubArticleLock, type HubLockCtx, type HubLockResult } from "@/lib/hub-article-lock";
import { internalError, invalid, logInternal, mapWriteError, notFound, resolveTenant } from "@/lib/hub-author-handlers";
import { readSmallBody } from "@/lib/hub-author-preview-pure";
import { revalidateTenantDoc } from "@/hooks/revalidate";
import { defaultFindMainTx, defaultLockRow, readMainAll, type FindMainTx } from "@/lib/hub-author-live-core";
import {
  editorialFlagsTenants,
  flagsChange,
  flagsGateReason,
  flagsPostWriteCheck,
  isEditorialFlagsTenant,
  parseFlagsBody,
  sameEditorialValues,
  storedEditorialValues,
  type HubEditorialValues,
  type HubFlagsGateReason,
  type HubFlagsInput,
} from "@/lib/hub-author-flags";
import type { TenantDoc } from "@/lib/tenant";

const SCOPE = "hub/articles/flags";

type Doc = Record<string, unknown>;
type Id = number | string;

// ── Response bodies (Public Contracts CMS 6) ─────────────────────────────────

const authorKeyRefused = () => json({ ok: false, status: "forbidden", reason: "author key cannot change flags" }, 403);
const flagsDisabled = () => json({ ok: false, status: "feature_disabled", reason: "editorial flags disabled for tenant" }, 403);
const notFlaggable = (reason: Exclude<HubFlagsGateReason, "draft_diverged">) => json({ ok: false, status: "not_flaggable", reason }, 422);
const draftDiverged = () => json({ ok: false, status: "draft_diverged", reason: "article has unpublished changes" }, 409);
const flagsConflict = (current: HubEditorialValues) =>
  json({ ok: false, status: "flags_conflict", reason: "flags changed since they were read", current }, 409);

// ── Seams ────────────────────────────────────────────────────────────────────

/** Injectable seams (unit checks / the probe only; production never passes them). */
export interface HubFlagsDeps {
  authenticate?: typeof authenticateHubWriteEngine;
  getPayload?: () => Promise<Payload>;
  lock?: typeof withHubArticleLock;
  /** `FOR NO KEY UPDATE` on the row (default `defaultLockRow`). */
  lockRow?: (payload: Payload, id: Id, req: PayloadRequest | undefined) => Promise<void>;
  /** Main-row reads on the transaction (gate, `pre`, `post`). */
  findMainTx?: FindMainTx;
  /** D3 (default: `editorialFlagsTenants()` read from the env on this call). */
  flagsTenants?: readonly string[];
  /** Server clock in ms (the `pinnedUntil` window; default `Date.now`). */
  now?: () => number;
  /** Called in the lock right before the write, after `pre` (test seam only). */
  beforeWrite?: () => Promise<void>;
  /** The post-commit webhook (default `revalidateTenantDoc`). */
  revalidate?: (payload: Payload, tenantId: Id, tags: readonly string[], slug: string | undefined) => Promise<void>;
}

/** N2: the flags body is tiny (four keys) — a tight cap, checked on Content-Length and on the stream. */
export const FLAGS_BODY_MAX_BYTES = 16_384;
/** The cache tags of the Articles collection hook (`revalidateHooks(["articles:all"])` in Articles.ts; pinned by test:hub-flags). */
export const ARTICLE_REVALIDATE_TAGS = ["articles:all"] as const;

const defaultGetPayload = () => getPayload({ config });

/** The write locale: the article's `sourceLanguage`, else the tenant's default language, else `en`. */
export function writeLocaleOf(main: Doc, tenant: { defaultLanguage?: unknown }): string {
  if (typeof main.sourceLanguage === "string" && main.sourceLanguage !== "") return main.sourceLanguage;
  if (typeof tenant.defaultLanguage === "string" && tenant.defaultLanguage !== "") return tenant.defaultLanguage;
  return "en";
}

/** A failed write → 422 (Payload ValidationError only) / 503 busy / 500 (logged by name + code). */
async function flagsWriteFailed(payload: Payload, engineId: Id, err: unknown): Promise<Response> {
  const m = mapWriteError(err);
  if (m.kind === "busy") return busyResponse();
  if (m.kind === "invalid" && (err as { name?: unknown } | null)?.name === "ValidationError") return invalid(m.fields);
  return logInternal(payload, engineId, err);
}

// ── Handler ──────────────────────────────────────────────────────────────────

/** What a committed write still has to do OUTSIDE the transaction (L2 / M1). */
interface CommittedFlagsWrite {
  articleId: number;
  tenantId: Id;
  slug: string | undefined;
  actor: HubFlagsInput["actor"];
  fields: string[];
  from: Partial<HubEditorialValues>;
  to: Partial<HubEditorialValues>;
}

export function handleHubFlags(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleHubFlagsWith(request, ctx);
}

export async function handleHubFlagsWith(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
  deps?: HubFlagsDeps,
): Promise<Response> {
  const { id } = await ctx.params;
  const payload = await (deps?.getPayload ?? defaultGetPayload)();
  const auth = await (deps?.authenticate ?? authenticateHubWriteEngine)({ payload, request });
  if (!auth.ok) return auth.response;
  const engine = auth.engine as { id: Id; hubAuthor?: boolean | null };
  // Like the live edit (D14): the author key never writes a published article, even with hubWrite.
  // Logged like every other key refusal (N1).
  if (engine.hubAuthor === true) {
    await logActivity({
      payload,
      eventType: "engine_action_denied",
      actorType: "engine",
      actorEngineId: engine.id,
      detail: { action: "hub_flags", reason: "author key cannot change flags" },
    });
    return authorKeyRefused();
  }
  const findMainTx = deps?.findMainTx ?? defaultFindMainTx;
  let committed: CommittedFlagsWrite | null = null;

  let res: Response;
  try {
    const body = await readSmallBody(request, FLAGS_BODY_MAX_BYTES);
    if (!body.ok) return body.response;
    const parsed = parseFlagsBody(body.raw, (deps?.now ?? Date.now)());
    if (!parsed.ok) return json(parsed.body, parsed.status);
    const v = parsed.value;

    const t = await resolveTenant(payload, auth, v.tenant);
    if (!t.ok) return t.response;
    const tenant = t.tenant;
    // D3: the CMS switch, before the first article read.
    if (!isEditorialFlagsTenant(tenant.slug, deps?.flagsTenants ?? editorialFlagsTenants())) return flagsDisabled();

    if (!isHubArticleId(id)) return notFound();
    const articleId = Number(id);

    // L1: the article must belong to THIS tenant BEFORE any lock is taken — an unlocked
    // tenant-only read, the same 404 body. A token of tenant A can therefore never hold a
    // row lock on a row of tenant B (no lock, no 503-vs-404 oracle). Ownership is checked
    // again inside the lock (the tenant column cannot be trusted across the gap).
    const owner = (await payload.findByID({ collection: "articles", id: articleId, depth: 0, overrideAccess: true, disableErrors: true, select: { tenant: true } as never })) as unknown as Doc | null;
    if (!owner || String(toId(owner.tenant)) !== String(tenant.id)) return notFound();

    res = await (deps?.lock ?? withHubArticleLock)({ tenantId: tenant.id, articleId }, (lk) => inLock(lk, { v, tenant, articleId }));
  } catch (err) {
    return logInternal(payload, engine.id, err);
  }

  // After the COMMIT only (the lock helper returned the success Response): the ActivityLog row
  // and the revalidate webhook. A rolled-back or failed write reaches neither.
  if (committed && res.status === 200) await afterCommit(committed);
  return res;

  /**
   * L2 — the audit row is written HERE, after the commit, not by the Articles hook inside the
   * transaction: a rolled-back write can then never leave a phantom row, and a logging failure
   * still never breaks the write (`logActivity` stays best-effort, outside the transaction;
   * joining the transaction instead would make an ActivityLog insert error abort — and roll
   * back — the flag change). Trade-off accepted: a crash between COMMIT and this insert loses
   * the row (at most once, never a false one). M1 — the webhook is posted once, after the
   * commit, so the frontend can only re-cache the NEW state, and no lock is held while it waits.
   */
  async function afterCommit(c: CommittedFlagsWrite): Promise<void> {
    await logActivity({
      payload,
      eventType: "human_edit",
      tenantId: c.tenantId,
      actorType: "engine",
      actorEngineId: engine.id,
      targetCollection: "articles",
      targetId: c.articleId,
      fromStatus: "published",
      toStatus: "published",
      detail: { via: "hub", actor: c.actor, action: "flags", fields: c.fields, from: c.from, to: c.to },
    });
    try {
      await (deps?.revalidate ?? revalidateTenantDoc)(payload, c.tenantId, ARTICLE_REVALIDATE_TAGS, c.slug);
    } catch (err) {
      payload.logger.warn(`[${SCOPE}] revalidate after commit failed: name=${(err as { name?: unknown } | null)?.name ?? typeof err}`);
    }
  }

  async function inLock(lk: HubLockCtx, s: { v: HubFlagsInput; tenant: TenantDoc; articleId: number }): Promise<HubLockResult> {
    const { v, tenant, articleId } = s;
    const fail = (value: Response): HubLockResult => ({ ok: false, value });
    // The row lock BEFORE any read inside the transaction: no other UPDATE of this row (CMS
    // admin, intake, crons, views) can land between the reads below and the write.
    await (deps?.lockRow ?? defaultLockRow)(payload, articleId, lk.req);
    const latest = (await payload.findByID({
      collection: "articles",
      id: articleId,
      draft: true,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
      req: lk.req,
    })) as unknown as Doc | null;
    if (!latest || String(toId(latest.tenant)) !== String(tenant.id)) return fail(notFound());
    const main = await findMainTx(payload, articleId, lk.req);
    if (!main || String(toId(main.tenant)) !== String(tenant.id)) return fail(notFound());

    const reason = flagsGateReason({ main, latest });
    if (reason === "draft_diverged") return fail(draftDiverged());
    if (reason) return fail(notFlaggable(reason));

    const current = storedEditorialValues(main);
    if (!sameEditorialValues(current, v.expected)) return fail(flagsConflict(current));
    const change = flagsChange(current, v.set, v.setKeys);
    if (change.changed.length === 0) {
      return { ok: true, value: json({ ok: true, id: articleId, tenant: tenant.slug, ...current, changed: [] }, 200) };
    }

    const pre = await readMainAll(payload, articleId, lk.req, findMainTx);
    if (!pre) return fail(notFound());
    if (deps?.beforeWrite) await deps.beforeWrite();
    // The three columns are not localized, but Payload validates the REQUIRED localized fields
    // (title, slug) in the write locale: write in the article's own source language, where they
    // exist (an article with no `en` row would otherwise get 422 title / slug). D8 still proves
    // that no localized value moved, on every locale.
    const writeLocale = writeLocaleOf(main, tenant);

    try {
      await payload.update({
        collection: "articles",
        id: articleId,
        req: lk.req,
        locale: writeLocale as never,
        data: { ...change.data } as never,
        depth: 0,
        overrideAccess: true,
        context: { hubFlags: { actor: v.actor, fields: change.changed, from: change.from, to: change.to }, engineId: engine.id, skipTranslationEnqueue: true, disableRevalidate: true },
      });
    } catch (err) {
      return fail(await flagsWriteFailed(payload, engine.id, err));
    }

    // D8: the post-write assertion, on the SAME transaction.
    const post = await readMainAll(payload, articleId, lk.req, findMainTx);
    const latestAfter = (await payload.findByID({
      collection: "articles",
      id: articleId,
      draft: true,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
      req: lk.req,
    })) as unknown as Doc | null;
    const check = flagsPostWriteCheck({ pre, post, latest: latestAfter, want: { ...current, ...change.to } });
    if (!check.ok) {
      // `fields` / `latest` = something landed on the article while we wrote (e.g. a human
      // Save Draft: the non-draft write merged it): rollback + 409 draft_diverged, like the live
      // route. `missing` / `values` = our own write did not land as asked: rollback + 500.
      if (check.leg === "fields" || check.leg === "latest") {
        payload.logger.warn(`[${SCOPE}] post-write check failed: article=${articleId} tenant=${tenant.slug} leg=${check.leg} keys=${check.detail.join(",")}`);
        return fail(draftDiverged());
      }
      payload.logger.error(`[${SCOPE}] post-write check failed: article=${articleId} tenant=${tenant.slug} leg=${check.leg} keys=${check.detail.join(",")}`);
      await logActivity({
        payload,
        eventType: "integration_error",
        tenantId: tenant.id,
        actorType: "engine",
        actorEngineId: engine.id,
        targetCollection: "articles",
        targetId: articleId,
        detail: { scope: SCOPE, name: "post_write_check", leg: check.leg, keys: check.detail },
      });
      return fail(internalError());
    }
    const values = storedEditorialValues(post as Doc);
    committed = {
      articleId,
      tenantId: tenant.id,
      slug: typeof main.slug === "string" ? main.slug : undefined,
      actor: v.actor,
      fields: change.changed,
      from: change.from,
      to: change.to,
    };
    return { ok: true, value: json({ ok: true, id: articleId, tenant: tenant.slug, ...values, changed: change.changed }, 200) };
  }
}
