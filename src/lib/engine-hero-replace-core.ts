/**
 * Engine hero replace — `POST /api/engine/articles/hero` (media-gtp-vowasia phase 5, R-b).
 *
 * Swaps ONLY `heroImage` on one article of one tenant, for a content engine that holds BOTH
 * `update_article` and `upload_media`, on a tenant listed in `ENGINE_HERO_REPLACE_TENANTS`
 * (default OFF). The wire contract (request, responses, check order) is frozen in the
 * content-engine plan `phase-5-hero-replace_PLAN_06-11-26.md` §Route contract and mirrored in
 * `docs/08-content-engine-integration.md` §Hero replace.
 *
 * Check order (first failure wins): JSON 400 -> size 413 -> getPayload 500 ->
 * authenticateEngine(update_article) 401/400/403 -> upload_media 403 (+ engine_action_denied)
 * -> tenant switch 403 feature_disabled (no article read) -> `articles` feature 422 -> fields
 * 400 -> article by engineDraftId in THIS tenant 404 -> gate-1 reads -> dryRun 200 ->
 * draft_diverged 409 -> idempotency 200 noop -> expectedHeroMediaId 409 hero_changed -> URL
 * guard 422 -> fetch + sniff + Media create OUTSIDE the lock (502 / 422) -> lock (503 busy) ->
 * row lock -> gate 2 (re-read, draft_diverged, idempotency, expected id) -> pre -> non-draft
 * update of heroImage only, `context.heroSwap` -> post-write check (409 + rollback) ->
 * read-back -> ONE `engine_write_accepted` row -> 200.
 *
 * Why the gate, the row lock and the post-write check: a non-draft `payload.update` loads the
 * LATEST version, merges the partial data into it and rewrites the whole document. Without
 * them a pending editor draft would go live and a concurrent Hide / cron / intake refresh
 * would be overwritten (same protections as the hub live-edit route). `draft: true` is not an
 * alternative: a draft save never touches the main row, so the live hero would not change.
 *
 * Residuals (accepted, recorded): a `_articles_v` draft INSERT between gate 2 and the write is
 * not blocked by `FOR NO KEY UPDATE` and not seen by the post-check; DNS rebinding between the
 * lookup and the connect; orphan Media when the lock or gate 2 refuses after the upload (kept
 * for audit; a retry with the same key reuses nothing but is answered by idempotency).
 *
 * This module has NO static `@payload-config` import: `route.ts` binds `getPayload`, the lock,
 * the row lock and the transaction read, so the unit tests run with a fake Payload.
 */
import type { Payload, PayloadRequest } from "payload";
import { authenticateEngine } from "@/lib/engine-auth";
import { scopedFind, scopedUpdate } from "@/lib/scoped";
import { featureEnabled } from "@/lib/tenant";
import { logActivity } from "@/lib/activity";
import { json } from "@/lib/http";
import { toId } from "@/access/helpers";
import { isSingleHomeRuleError, humanErrorMessage } from "@/lib/single-home-pillars";
import type { HubLockCtx, HubLockResult } from "@/lib/hub-article-lock";
import { heroReplaceAllowLocal, heroReplaceUrlHosts, isHeroReplaceTenant } from "@/lib/engine-hero-replace-switch";
import {
  HERO_ALLOWED_TYPES,
  HERO_BODY_MAX_BYTES,
  HERO_FETCH_TIMEOUT_MS,
  HERO_IMAGE_MAX_BYTES,
  filenameHasHeroToken,
  heroFilenameFor,
  heroGateReason,
  heroPostWriteCheck,
  mediaIdOf,
  parseHeroReplaceBody,
  validateHeroFetchUrl,
} from "@/lib/engine-hero-replace-pure";
import { uploadHeroMedia, type HeroUploadDeps } from "@/lib/engine-hero-upload";
import { revalidateAfterCommit } from "@/hooks/revalidate";

type Doc = Record<string, unknown>;
type Id = number | string;
type Env = Record<string, string | undefined>;

export interface HeroReplaceDeps {
  getPayload: () => Promise<Payload>;
  /** `withHubArticleLock` (advisory key shared with hub writes). */
  lock: (args: { tenantId: Id; articleId?: number }, fn: (ctx: HubLockCtx) => Promise<HubLockResult>) => Promise<Response>;
  /** `defaultLockRow`: `SELECT 1 FROM articles WHERE id=$1 FOR NO KEY UPDATE` on the transaction. */
  lockRow: (payload: Payload, id: Id, req: PayloadRequest | undefined) => Promise<void>;
  /** `readMainAll`: the main row, every locale, depth 0, on `req`. */
  readMainAll: (payload: Payload, id: Id, req: PayloadRequest | undefined) => Promise<Doc | null>;
  authenticate?: typeof authenticateEngine;
  env?: Env;
  fetch?: HeroUploadDeps["fetch"];
  resolveHost?: HeroUploadDeps["resolveHost"];
  /**
   * The tenant frontend webhook, sent ONCE after the locked write committed (the write itself
   * runs with `context.disableRevalidate`, so the hook never posts while the row and the
   * advisory lock are held). Default `revalidateAfterCommit`; best-effort.
   */
  revalidate?: (payload: Payload, tenantId: Id, body: Doc) => Promise<void>;
  /** Test / probe seam: runs in the lock right before the write, after gate 2. */
  beforeWrite?: () => Promise<void>;
}

const ROUTE = "engine/articles/hero";

const err = (status: number, code: string, reason?: string, extra: Doc = {}) =>
  json({ ok: false, status: code, ...(reason !== undefined ? { reason } : {}), ...extra }, status);
const notFound = () => err(404, "not_found", "article not found");
const draftDiverged = () => err(409, "draft_diverged", "article has unpublished changes");
const heroChanged = (current: number | null) => err(409, "hero_changed", "current hero differs from expectedHeroMediaId", { currentHeroMediaId: current });
const internal = () => err(500, "error", "internal error");

const versionOf = (d: Doc): number => (typeof d.version === "number" ? d.version : 0);
const asString = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as Doc).en === "string") return (v as Doc).en as string;
  return "";
};

async function readLatest(payload: Payload, id: number, req?: PayloadRequest): Promise<Doc | null> {
  return (await payload.findByID({
    collection: "articles",
    id,
    draft: true,
    depth: 0,
    locale: "en" as never,
    overrideAccess: true,
    disableErrors: true,
    ...(req ? { req } : {}),
  })) as unknown as Doc | null;
}

async function readMedia(payload: Payload, id: number | null, req?: PayloadRequest): Promise<Doc | null> {
  if (id == null) return null;
  return (await payload.findByID({
    collection: "media",
    id,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
    ...(req ? { req } : {}),
  })) as unknown as Doc | null;
}

const sameTenant = (doc: Doc | null, tenantId: Id): doc is Doc => !!doc && String(toId(doc.tenant as never)) === String(tenantId);

export async function handleHeroReplace(request: Request, deps: HeroReplaceDeps): Promise<Response> {
  const env = deps.env ?? process.env;

  // 1. JSON, then 2. size measured on the text (content-length is never trusted).
  let text: string;
  let raw: unknown;
  try {
    text = await request.text();
    raw = JSON.parse(text);
  } catch {
    return err(400, "bad_request", "invalid JSON body");
  }
  if (Buffer.byteLength(text, "utf8") > HERO_BODY_MAX_BYTES) return err(413, "too_large", `body over ${HERO_BODY_MAX_BYTES} bytes`);

  let payload: Payload;
  try {
    payload = await deps.getPayload();
  } catch {
    return internal();
  }

  const pubRaw = raw && typeof raw === "object" ? (raw as Doc).publicationId : undefined;
  const publicationId = typeof pubRaw === "string" && pubRaw.trim() ? pubRaw.trim() : undefined;

  // 3. Engine auth (update_article), then 4. the second action.
  const auth = await (deps.authenticate ?? authenticateEngine)({ payload, request, action: "update_article", publicationId });
  if (!auth.ok) return auth.response;
  const { engine, tenant } = auth;
  if (!(engine.allowedActions ?? []).includes("upload_media")) {
    await logActivity({ payload, eventType: "engine_action_denied", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, detail: { action: "upload_media" } });
    return err(403, "forbidden", "action not allowed: upload_media");
  }

  // 5. The CMS switch, before any article read.
  const disabled = async (reason: string) => {
    await logActivity({ payload, eventType: "engine_action_denied", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, detail: { action: "replace_hero", reason } });
    return err(403, "feature_disabled", reason);
  };
  if (!isHeroReplaceTenant(String(tenant.slug), env)) return disabled("hero replace disabled for tenant");
  // 5b. Fail closed: an enabled tenant with no host allowlist would fetch from any public host.
  const allowLocal = heroReplaceAllowLocal(env);
  if (!allowLocal && heroReplaceUrlHosts(env).length === 0) return disabled("hero replace url hosts not configured");

  // 6. Feature gate.
  if (!featureEnabled(tenant, "articles")) {
    await logActivity({ payload, eventType: "integration_error", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, detail: { route: ROUTE, reason: "articles feature disabled" } });
    return err(422, "unprocessable", "articles feature disabled for tenant");
  }

  try {
    // 7. Fields.
    const parsed = parseHeroReplaceBody(raw);
    if (!parsed.ok) return err(400, "bad_request", `invalid fields: ${parsed.fields.join(", ")}`);
    const v = parsed.value;

    // 8. Article by engineDraftId, THIS tenant only (a foreign id is a plain 404).
    const found = await scopedFind({
      payload,
      collection: "articles",
      tenantId: tenant.id,
      where: { engineDraftId: { equals: v.engineDraftId } },
      limit: 1,
      depth: 0,
      locale: "en",
    });
    const hit = found.docs[0] as Doc | undefined;
    if (!hit || hit.id == null) return notFound();
    const articleId = Number(hit.id);
    // E17: Media `alt` is required; it is the default-locale title STRING, as on intake.
    const title = asString(hit.title);
    const slug = asString(hit.slug);

    // 9. Gate-1 reads.
    const latest = await readLatest(payload, articleId);
    const main = await deps.readMainAll(payload, articleId, undefined);
    if (!sameTenant(main, tenant.id) || (latest && !sameTenant(latest, tenant.id))) return notFound();
    const currentId = mediaIdOf(main.heroImage);
    const current = await readMedia(payload, currentId);
    const diverged = heroGateReason(main, latest) !== null;

    // 10. Dry run: inspect only (no fetch, no write, no activity row).
    if (v.dryRun) {
      return json({
        ok: true,
        status: "dry_run",
        articleId,
        currentHeroMediaId: currentId,
        currentHeroCredit: typeof current?.credit === "string" ? current.credit : null,
        currentHeroFilename: typeof current?.filename === "string" ? current.filename : null,
        version: versionOf(main),
        workflowStatus: main.workflowStatus ?? null,
        draftDiverged: diverged,
      }, 200);
    }
    const key = v.replacementKey as string;

    if (diverged) return draftDiverged();
    if (filenameHasHeroToken(current?.filename as string | undefined, key)) {
      return json({ ok: true, status: "noop", articleId, currentHeroMediaId: currentId, heroUrl: current?.url ?? null }, 200);
    }
    if (currentId !== v.expectedHeroMediaId) return heroChanged(currentId);

    // 11. Source URL guard, then fetch + sniff + Media create OUTSIDE the lock.
    const urlCheck = validateHeroFetchUrl(v.heroImageUrl as string, { allowLocal, hosts: heroReplaceUrlHosts(env) });
    // L5: the guard reason only, never the URL.
    const badUrl = async (reason: string) => {
      await logActivity({ payload, eventType: "integration_error", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, targetCollection: "articles", targetId: articleId, detail: { route: ROUTE, reason: `invalid_hero_url: ${reason}` } });
      return err(422, "unprocessable", `invalid_hero_url: ${reason}`);
    };
    if (!urlCheck.ok) return badUrl(urlCheck.reason);
    const up = await uploadHeroMedia(
      payload,
      { tenantId: tenant.id, url: urlCheck.url.toString(), title, slug, credit: v.imageCredit, caption: v.imageCaption },
      {
        maxBytes: HERO_IMAGE_MAX_BYTES,
        allowedTypes: HERO_ALLOWED_TYPES,
        timeoutMs: HERO_FETCH_TIMEOUT_MS,
        sniff: true,
        allowLocal,
        filenameFor: (ext) => heroFilenameFor(slug, key, ext),
      },
      { fetch: deps.fetch, resolveHost: deps.resolveHost },
    );
    if (!up.ok) {
      if (up.code === "fetch_failed" || up.code === "upload_failed") return err(502, "hero_upload_failed", up.reason);
      if (up.code === "invalid_hero_url") return badUrl(up.reason);
      return err(422, "unprocessable", `${up.code}: ${up.reason}`);
    }
    const newId = up.id;

    // 12. The locked write.
    let accepted: { oldId: number | null; version: number } | null = null;
    const res = await deps.lock({ tenantId: tenant.id, articleId }, async (lk): Promise<HubLockResult> => {
      const fail = (value: Response): HubLockResult => ({ ok: false, value });
      await deps.lockRow(payload, articleId, lk.req);
      const latest2 = await readLatest(payload, articleId, lk.req);
      const main2 = await deps.readMainAll(payload, articleId, lk.req);
      if (!sameTenant(main2, tenant.id)) return fail(notFound());
      if (heroGateReason(main2, latest2)) return fail(draftDiverged());
      const cur2 = mediaIdOf(main2.heroImage);
      const curDoc = await readMedia(payload, cur2, lk.req);
      if (filenameHasHeroToken(curDoc?.filename as string | undefined, key)) {
        return { ok: true, value: json({ ok: true, status: "noop", articleId, currentHeroMediaId: cur2, heroUrl: curDoc?.url ?? null }, 200) };
      }
      if (cur2 !== v.expectedHeroMediaId) return fail(heroChanged(cur2));
      const pre = main2;
      if (deps.beforeWrite) await deps.beforeWrite();

      try {
        await scopedUpdate({
          payload,
          collection: "articles",
          tenantId: tenant.id,
          id: articleId,
          data: { heroImage: newId },
          locale: "en",
          req: lk.req,
          depth: 0,
          // `disableRevalidate`: the webhook is sent after commit (step 13), not from the hook.
          context: { engineWrite: true, engineId: engine.id, heroSwap: true, disableRevalidate: true },
        });
      } catch (e) {
        if (isSingleHomeRuleError(e)) return fail(err(422, "unprocessable", humanErrorMessage(e)));
        if ((e as Error)?.name === "ValidationError") {
          await logActivity({ payload, eventType: "integration_error", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, targetCollection: "articles", targetId: articleId, detail: { route: ROUTE, reason: "article_invalid", message: humanErrorMessage(e) } });
          return fail(err(422, "unprocessable", "article_invalid"));
        }
        throw e;
      }

      const post = await deps.readMainAll(payload, articleId, lk.req);
      const latestAfter = await readLatest(payload, articleId, lk.req);
      const check = heroPostWriteCheck({ pre, post, latestAfter });
      if (!check.ok) {
        payload.logger.warn(`[${ROUTE}] post-write check failed: article=${articleId} tenant=${tenant.slug} leg=${check.reason} keys=${check.detail.join(",")}`);
        return fail(draftDiverged());
      }
      // L4: the row must now point at the Media this call created.
      if (mediaIdOf(post?.heroImage) !== mediaIdOf(newId)) {
        payload.logger.warn(`[${ROUTE}] post-write check failed: article=${articleId} tenant=${tenant.slug} leg=hero keys=heroImage`);
        return fail(draftDiverged());
      }
      accepted = { oldId: cur2, version: versionOf(post as Doc) };
      return { ok: true, value: json({ ok: true }, 200) };
    });
    const done = accepted as { oldId: number | null; version: number } | null;
    if (!done || res.status !== 200) return res;

    // 13. Read-back (committed) for the hero URL, then exactly one activity row.
    const back = (await payload.findByID({ collection: "articles", id: articleId, depth: 1, overrideAccess: true, disableErrors: true })) as unknown as Doc | null;
    const hero = back?.heroImage;
    const heroUrl = hero && typeof hero === "object" ? ((hero as Doc).url ?? null) : null;
    await logActivity({
      payload,
      eventType: "engine_write_accepted",
      tenantId: tenant.id,
      actorType: "engine",
      actorEngineId: engine.id,
      targetCollection: "articles",
      targetId: articleId,
      detail: { action: "replace_hero", reason: v.reason, replacementKey: key, oldMediaId: done.oldId, newMediaId: newId },
    });
    // Committed: notify the tenant frontend once (best-effort, never fails the request).
    try {
      await (deps.revalidate ?? revalidateAfterCommit)(payload, tenant.id, { tags: ["articles:all"], slug: asString(back?.slug) || slug });
    } catch {
      /* best-effort */
    }
    return json({ ok: true, status: "replaced", articleId, oldMediaId: done.oldId, newMediaId: newId, heroUrl, version: done.version }, 200);
  } catch (e) {
    await logActivity({ payload, eventType: "integration_error", tenantId: tenant.id, actorType: "engine", actorEngineId: engine.id, detail: { route: ROUTE, message: (e as Error)?.message ?? String(e) } });
    return internal();
  }
}
