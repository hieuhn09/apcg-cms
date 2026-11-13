/**
 * Hero focal point — the write (content-engine plan
 * process/features/apcg-hub/active/hub-hero-focal-point_PLAN_10-11-26.md, P1.3 / P1.4; D7, D8,
 * D10, D13, D15, D16, D18; validate C4, C10, N8).
 *
 * The focal point rides on the article save (`heroFocal` on POST / PATCH `/api/hub/articles` and
 * on `PATCH …/live`); there is NO "edit any media" route. Order, in the three handlers:
 *
 *   1. BEFORE the lock (`heroFocalPrecheck`, N8): switch on AND `heroFocal` is an object AND the
 *      article will have no hero after this save ⇒ 422 `fields.heroFocal: "unknown_ref"`.
 *      `heroFocal: null` without a hero ⇒ nothing to do (no error, no warning).
 *   2. The article write runs and COMMITS exactly as before (`withHubArticleLock`); the focal is
 *      never written inside that transaction: a failing focal write there would roll back the
 *      article (D10 / C4).
 *   3. Only on a 2xx answer (`finishWithHeroFocal`): `applyHeroFocalAfterCommit` re-reads the
 *      article (draft paths: the latest version; live: the main row), takes ITS hero id (the hub
 *      never names a media id), checks the article AND the media belong to THIS tenant (C10:
 *      `scopedUpdate` would silently move a foreign media into this tenant, so it is not used),
 *      then writes ONLY `{focalX, focalY}` through the Local API with a FRESH `createLocalReq`
 *      (no `transactionID`, no `req.file`, no `uploadEdits`: P0.3 proved no file is touched).
 *   4. Any failure, or the tenant outside `HUB_FOCAL_TENANTS` ⇒ the SAME status and body plus
 *      `warnings: ["hero_focal_not_applied"]` (D10). No warning when `heroFocal` was absent: the
 *      handler then returns its Response object untouched (byte-identical).
 *
 * No ActivityLog row here (D18: the hub writes its own activity line). Logs carry ids, a reason
 * code and an error NAME / CODE only.
 */

import { createLocalReq, type Payload, type PayloadRequest } from "payload";
import { toId } from "@/access/helpers";
import type { HubFieldErrors } from "@/lib/hub-author-limits";
import {
  HERO_FOCAL_NOT_APPLIED,
  focalColumnsEqual,
  focalTenants,
  focalToColumns,
  isFocalTenant,
  type HubHeroFocal,
} from "@/lib/hub-hero-focal-pure";

const SCOPE = "hub/hero-focal";

type Doc = Record<string, unknown>;
type Id = number | string;

/** Injectable seams (unit checks only; production never passes them). */
export interface HubFocalDeps {
  /** D15 (default: `focalTenants()` read from the env on this call). */
  tenants?: readonly string[];
  /** The request used for the focal-only media write (default: `focalLocalReq`). */
  createReq?: (payload: Payload) => Promise<PayloadRequest>;
}

/** D15: the CMS switch for this tenant slug, read now. */
export function focalEnabledFor(slug: string, deps?: HubFocalDeps): boolean {
  return isFocalTenant(slug, deps?.tenants ?? focalTenants());
}

/**
 * N8, BEFORE the lock. `heroAfter` = the hero id the article will have after this save
 * (create: the request's checked `heroImageId`; PATCH: the request's when present, else the
 * latest version's; live: the main row's). Switch off ⇒ never an error (the save goes through and
 * the answer carries the warning instead).
 */
export function heroFocalPrecheck(a: { heroFocal: HubHeroFocal | null | undefined; heroAfter: unknown; enabled: boolean }): HubFieldErrors | null {
  if (a.heroFocal === undefined || a.heroFocal === null || !a.enabled) return null;
  return toId(a.heroAfter) == null ? { heroFocal: "unknown_ref" } : null;
}

/** The fresh request of the focal write: no transaction, no file, no upload edits (P0.3). */
export async function focalLocalReq(payload: Payload): Promise<PayloadRequest> {
  return (await createLocalReq({ context: {} }, payload)) as PayloadRequest;
}

/**
 * `none`        — `heroFocal` absent (the caller never gets here in practice)
 * `applied`     — `{focalX, focalY}` written on the hero media
 * `unchanged`   — the media already had exactly these values (no write)
 * `skipped`     — `heroFocal: null` and the article has no hero (nothing to centre)
 * `not_applied` — switch off, or any check / write failed ⇒ the D10 warning
 */
export type HeroFocalOutcome = "none" | "applied" | "unchanged" | "skipped" | "not_applied";

function errName(err: unknown): string {
  const n = (err as { name?: unknown } | null)?.name;
  return typeof n === "string" ? n : typeof err;
}

function errCode(err: unknown): string | undefined {
  const c = (err as { code?: unknown; cause?: { code?: unknown } } | null) ?? null;
  const v = c?.code ?? c?.cause?.code;
  return typeof v === "string" ? v : undefined;
}

/**
 * Step 3 above. Never throws. `draft: true` reads the LATEST version (hub drafts keep the main row
 * frozen until publish); `draft: false` reads the main row (live edit).
 */
export async function applyHeroFocalAfterCommit(
  payload: Payload,
  a: { tenant: { id: Id; slug: string }; articleId: Id; heroFocal: HubHeroFocal | null | undefined; draft: boolean },
  deps?: HubFocalDeps,
): Promise<HeroFocalOutcome> {
  if (a.heroFocal === undefined) return "none";
  const notApplied = (reason: string): HeroFocalOutcome => {
    payload.logger.warn(`[${SCOPE}] not applied: reason=${reason} article=${String(a.articleId)} tenant=${a.tenant.slug}`);
    return "not_applied";
  };
  if (!focalEnabledFor(a.tenant.slug, deps)) return notApplied("tenant_disabled");
  try {
    const article = (await payload.findByID({
      collection: "articles",
      id: a.articleId,
      ...(a.draft ? { draft: true } : {}),
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })) as unknown as Doc | null;
    if (!article || String(toId(article.tenant)) !== String(a.tenant.id)) return notApplied("article");
    const heroId = toId(article.heroImage);
    if (heroId == null) return a.heroFocal === null ? "skipped" : notApplied("no_hero");
    const media = (await payload.findByID({
      collection: "media",
      id: heroId,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })) as unknown as Doc | null;
    // C10: the media must be THIS article's hero and of THIS tenant before anything is written.
    if (!media || String(toId(media.id)) !== String(heroId)) return notApplied("media_not_hero");
    if (String(toId(media.tenant)) !== String(a.tenant.id)) return notApplied("media_tenant");
    const cols = focalToColumns(a.heroFocal);
    if (focalColumnsEqual(media, cols)) return "unchanged";
    const req = await (deps?.createReq ?? focalLocalReq)(payload);
    await payload.update({
      collection: "media",
      id: heroId,
      data: { focalX: cols.focalX, focalY: cols.focalY } as never,
      req,
      depth: 0,
      overrideAccess: true,
    });
    return "applied";
  } catch (err) {
    const code = errCode(err);
    return notApplied(`write_failed name=${errName(err)}${code ? ` code=${code}` : ""}`);
  }
}

/**
 * Step 3 + 4: only a 2xx answer runs the focal write; `not_applied` re-emits the SAME status,
 * headers and JSON body plus `warnings: ["hero_focal_not_applied"]`. Anything else (or a body
 * that is not a JSON object) returns `res` unchanged. `apply` receives the parsed body (create
 * needs its `id`).
 */
export async function finishWithHeroFocal(res: Response, apply: (body: Doc) => Promise<HeroFocalOutcome>): Promise<Response> {
  if (res.status < 200 || res.status >= 300) return res;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return res;
  const outcome = await apply(body as Doc);
  if (outcome !== "not_applied") return res;
  return new Response(JSON.stringify({ ...(body as Doc), warnings: [HERO_FOCAL_NOT_APPLIED] }), {
    status: res.status,
    headers: res.headers,
  });
}
