/**
 * Hub AUTHOR write handlers (APCGHub P5.1 — "Nháp chữ"): create and update one
 * DRAFT article from the hub composer. Public Contracts (POST / PATCH) are frozen
 * in the plan, including every error body; the check order below is the contract's.
 *
 *   POST  /api/hub/articles          → handleHubDraftCreate(request)
 *   PATCH /api/hub/articles/{id}     → handleHubDraftUpdate(request, ctx)
 *
 * POST order (first failure wins): auth (401 / 403 hubRead / 403 hubAuthor) → body
 * ≤ 1,000,000 bytes (413) → JSON / object / tenant / unknown keys (400) → pure
 * checks incl. body (1)–(3) + 1b (422) → tenant ∈ grant (403, logged) →
 * `features.articles` (403 feature_disabled) → references + blocked pillar (422) →
 * conversion in ONE vm call (422) → slug in use, main table OR latest draft (409)
 * → create.
 *
 * PATCH order: auth → 413 → 400 / 422 → tenant (403) → feature (403) → id shape +
 * int4 (404) → latest draft AND main row in THAT tenant (404) → both
 * `origin === "manual"` + `workflowStatus === "draft"`, latest hub-authored (422
 * not_editable) → `expectedVersion` === latest version (409) → (with bodyMarkdown)
 * stored body round-trip safe, else 422 body_not_editable → references (422) →
 * merge rules (422) → (with a non-empty body) conversion (422) → (slug changed)
 * slug in use (409) → nothing changed ⇒ 200 `changed: []`, no write → re-read the
 * main row right before the write (422 if no longer a manual draft) → update with
 * `draft: true` (D20 branch B: a published main row can never be taken down).
 *
 * Server-forced (the hub never sends them): `workflowStatus: "draft"`,
 * `_status: "draft"` (POST and PATCH); POST also `origin: "manual"`,
 * `editedByHuman: true`, `contentType: "article"`, `sourceLanguage`,
 * `lastEngine` (= this engine — the hook stamps it only for engine writes),
 * `tenant`. `context.disableRevalidate` (a draft has no public cache to refresh).
 *
 * Logs: never `err.message`, body text or a token — an error NAME and CODE only.
 * The exported route wrappers take one / two arguments and NEVER pass `deps`; the
 * `…With(request, …, deps?)` functions exist for unit checks only.
 */

import { getPayload, type Payload } from "payload";
import config from "@payload-config";
import { isHubArticleId } from "@/lib/hub-article-id";
import { isEmptyBody, loadHubEditorConfig } from "@/lib/hub-article-markdown";
import { logActivity } from "@/lib/activity";
import { json } from "@/lib/http";
import { featureEnabled, findTenantById, type TenantDoc } from "@/lib/tenant";
import { toId } from "@/access/helpers";
import { authenticateHubAuthorEngine, isHubAuthoredDoc, resolveHubWriteTenant } from "@/lib/hub-author-auth";
import {
  MAX_REQUEST_BYTES,
  READ_MIN_MAX,
  READ_MIN_MIN,
  READ_WORDS_PER_MINUTE,
  TENANT_LOG_CHARS,
  type HubFieldErrors,
} from "@/lib/hub-author-limits";
import {
  invalidBody,
  parseCreateBody,
  parseUpdateBody,
  type HubDraftFieldKey,
  type HubDraftInput,
  type HubParseResult,
} from "@/lib/hub-author-input";
import { convertBody, isRoundTripSafeBody, lexicalTreesEqual, type ConvertResult, type HubEditorConfig } from "@/lib/hub-author-body";
import { findSlugConflict, resolveDraftRefs, type ResolvedRefs } from "@/lib/hub-author-refs";

const SCOPE = "hub/articles/author";

type Doc = Record<string, unknown>;
type Id = number | string;

/** Injectable seams (unit checks only; production never passes them). */
export interface HubDraftDeps {
  authenticate?: typeof authenticateHubAuthorEngine;
  /** Body conversion (default: `convertBody`, ONE vm call). */
  convert?: (payload: Payload, md: string) => Promise<ConvertResult>;
  /** Read the MAIN table row (no `draft`) — also the re-read right before the update (E7). */
  findMain?: (payload: Payload, id: Id) => Promise<Doc | null>;
  getPayload?: () => Promise<Payload>;
}

// ── Frozen response bodies ───────────────────────────────────────────────────

const notFound = () => json({ ok: false, status: "not_found", reason: "article not found for tenant" }, 404);
const featureDisabled = () =>
  json({ ok: false, status: "feature_disabled", reason: "articles feature disabled for tenant" }, 403);
const tooLarge = () => json({ ok: false, status: "too_large", reason: `request body exceeds ${MAX_REQUEST_BYTES} bytes` }, 413);
const badJson = () => json({ ok: false, status: "bad_request", reason: "body must be valid JSON" }, 400);
const invalid = (fields: HubFieldErrors) => json(invalidBody(fields), 422);
const notEditable = (reason: "origin" | "status" | "not_hub_authored") =>
  json({ ok: false, status: "not_editable", reason }, 422);
const bodyNotEditable = () =>
  json({ ok: false, status: "body_not_editable", reason: "existing body cannot be edited as Markdown" }, 422);
const slugConflict = (id: Id | null) =>
  json({ ok: false, status: "slug_conflict", reason: "slug already exists for this tenant", existing: { id } }, 409);
const versionConflict = (currentVersion: number) =>
  json({ ok: false, status: "version_conflict", reason: "article version changed", currentVersion }, 409);
const internalError = () => json({ ok: false, status: "internal_error" }, 500);

// ── Error mapping (pure) ─────────────────────────────────────────────────────

export type MappedWriteError =
  | { kind: "invalid"; status: 422; fields: HubFieldErrors }
  | { kind: "slug_conflict"; status: 409 }
  | { kind: "internal"; status: 500; name: string; code?: string };

function errCode(err: unknown): string | undefined {
  const o = (typeof err === "object" && err !== null ? err : {}) as { code?: unknown; cause?: unknown };
  if (typeof o.code === "string") return o.code;
  const c = (typeof o.cause === "object" && o.cause !== null ? o.cause : {}) as { code?: unknown };
  return typeof c.code === "string" ? c.code : undefined;
}

function errName(err: unknown): string {
  const n = (err as { name?: unknown } | null)?.name;
  return typeof n === "string" ? n : typeof err;
}

/**
 * A failed `payload.create / update` → the frozen response class.
 *   Payload `ValidationError` ⇒ 422 `invalid`, each `fields.<path>` = "invalid"
 *     (the Payload message is NEVER copied);
 *   the per-tenant slug hook ("… already exists for this tenant") ⇒ 409 slug_conflict;
 *   Postgres class 22 (data exception) ⇒ 422 `invalid`; class 23 (integrity) ⇒ 409;
 *   anything else ⇒ 500 (logged by NAME + CODE only).
 */
export function mapWriteError(err: unknown): MappedWriteError {
  const name = errName(err);
  const data = (err as { data?: { errors?: unknown } } | null)?.data;
  if (name === "ValidationError" && Array.isArray(data?.errors)) {
    const fields: HubFieldErrors = {};
    for (const e of data.errors as { path?: unknown }[]) {
      if (typeof e?.path === "string" && e.path !== "") fields[e.path] = "invalid";
    }
    return { kind: "invalid", status: 422, fields };
  }
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.includes("already exists for this tenant")) {
    return { kind: "slug_conflict", status: 409 };
  }
  const code = errCode(err);
  if (code && /^22[0-9A-Z]{3}$/.test(code)) return { kind: "invalid", status: 422, fields: {} };
  if (code && /^23[0-9A-Z]{3}$/.test(code)) return { kind: "slug_conflict", status: 409 };
  return code ? { kind: "internal", status: 500, name, code } : { kind: "internal", status: 500, name };
}

// ── Shared steps ─────────────────────────────────────────────────────────────

async function readBody(request: Request): Promise<{ ok: true; raw: unknown } | { ok: false; response: Response }> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) return { ok: false, response: tooLarge() };
  try {
    return { ok: true, raw: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: badJson() };
  }
}

function parsedResponse(r: Extract<HubParseResult, { ok: false }>): Response {
  return json(r.body, r.status);
}

/** Tenant ∈ grant (403 + log, `requested` cut to 64 chars — E15) and `features.articles` (403). */
async function resolveTenant(
  payload: Payload,
  auth: { engine: { id: Id }; tenants: { id: Id; slug: string }[] },
  requested: string,
): Promise<{ ok: true; tenant: TenantDoc } | { ok: false; response: Response }> {
  const ref = resolveHubWriteTenant(auth.tenants, requested);
  if (!ref) {
    await logActivity({
      payload,
      eventType: "engine_tenant_denied",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: SCOPE, requested: String(requested).slice(0, TENANT_LOG_CHARS) },
    });
    return {
      ok: false,
      response: json(
        { ok: false, status: "forbidden", reason: "tenant not in allowed scope", allowedTenants: auth.tenants.map((t) => t.slug) },
        403,
      ),
    };
  }
  const tenant = await findTenantById(payload, ref.id);
  if (!tenant || !featureEnabled(tenant, "articles")) return { ok: false, response: featureDisabled() };
  return { ok: true, tenant };
}

async function logInternal(payload: Payload, engineId: Id, err: unknown): Promise<Response> {
  const name = errName(err);
  const code = errCode(err);
  payload.logger.error(`[${SCOPE}] write failed: name=${name}${code ? ` code=${code}` : ""}`);
  await logActivity({
    payload,
    eventType: "integration_error",
    actorType: "engine",
    actorEngineId: engineId,
    detail: code ? { scope: SCOPE, name, code } : { scope: SCOPE, name },
  });
  return internalError();
}

/** A guarded-conversion rejection: 422 `fields.bodyMarkdown`; server log = reason + error name / code only. */
function conversionRejected(payload: Payload, r: Extract<ConvertResult, { ok: false }>): Response {
  payload.logger.warn(
    `[${SCOPE}] body rejected: reason=${r.reason}${r.error ? ` name=${r.error.name}${r.error.code ? ` code=${r.error.code}` : ""}` : ""}`,
  );
  return invalid({ bodyMarkdown: r.reason });
}

/** `max(1, min(120, round(words / 220)))`. */
export function estimateReadMin(markdown: string): number {
  const words = markdown.split(/\s+/).filter(Boolean).length;
  return Math.max(READ_MIN_MIN, Math.min(READ_MIN_MAX, Math.round(words / READ_WORDS_PER_MINUTE)));
}

async function slugConflictResponse(payload: Payload, tenantId: Id, slug: string | undefined, excludeId?: Id): Promise<Response> {
  let id: Id | null = null;
  if (slug) {
    try {
      id = (await findSlugConflict({ payload, tenantId, slug, excludeId }))?.id ?? null;
    } catch {
      id = null;
    }
  }
  return slugConflict(id);
}

/** The write failed: map it (422 / 409 / 500). */
async function writeFailed(payload: Payload, engineId: Id, tenantId: Id, slug: string | undefined, err: unknown, excludeId?: Id) {
  const m = mapWriteError(err);
  if (m.kind === "invalid") return invalid(m.fields);
  if (m.kind === "slug_conflict") return slugConflictResponse(payload, tenantId, slug, excludeId);
  return logInternal(payload, engineId, err);
}

const defaultGetPayload = () => getPayload({ config });
const defaultFindMain = async (payload: Payload, id: Id): Promise<Doc | null> =>
  (await payload.findByID({ collection: "articles", id, depth: 0, overrideAccess: true, disableErrors: true })) as unknown as Doc | null;
const defaultConvert = (payload: Payload, md: string) => convertBody(payload, md);

// ── POST (create) ────────────────────────────────────────────────────────────

export function handleHubDraftCreate(request: Request): Promise<Response> {
  return handleHubDraftCreateWith(request);
}

export async function handleHubDraftCreateWith(request: Request, deps?: HubDraftDeps): Promise<Response> {
  const payload = await (deps?.getPayload ?? defaultGetPayload)();
  const auth = await (deps?.authenticate ?? authenticateHubAuthorEngine)({ payload, request });
  if (!auth.ok) return auth.response;
  const engine = auth.engine;

  try {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const parsed = parseCreateBody(body.raw);
    if (!parsed.ok) return parsedResponse(parsed);
    const v = parsed.value;

    const t = await resolveTenant(payload, auth, v.tenant);
    if (!t.ok) return t.response;
    const tenant = t.tenant;

    const refsR = await resolveDraftRefs({ payload, tenant, input: v });
    if (!refsR.ok) return invalid(refsR.fields);
    const refs = refsR.refs;

    let lexical: unknown = undefined;
    if (v.bodyMarkdown) {
      const c = await (deps?.convert ?? defaultConvert)(payload, v.bodyMarkdown);
      if (!c.ok) return conversionRejected(payload, c);
      lexical = c.lexical;
    }

    if (v.slug && (await findSlugConflict({ payload, tenantId: tenant.id, slug: v.slug }))) {
      return slugConflictResponse(payload, tenant.id, v.slug);
    }

    const data: Doc = {
      tenant: tenant.id,
      _status: "draft",
      workflowStatus: "draft",
      origin: "manual",
      editedByHuman: true,
      contentType: "article",
      sourceLanguage: tenant.defaultLanguage,
      lastEngine: engine.id,
      title: v.title,
      slug: v.slug,
      readMin: v.readMin ?? estimateReadMin(v.bodyMarkdown ?? ""),
      pillar: refs.pillar,
      author: refs.author,
    };
    if (v.dek != null) data.dek = v.dek;
    if (lexical !== undefined) data.body = lexical;
    if (v.takeaways && v.takeaways.length) data.takeaways = v.takeaways.join("\n");
    if (refs.subSection != null) data.subSection = refs.subSection;
    if (refs.secondarySections) data.secondarySections = refs.secondarySections;
    if (refs.tags) data.tags = refs.tags;
    if (refs.countries) {
      data.countries = refs.countries;
      data.country = refs.countries[0] ?? null;
    }
    if (refs.cities) data.cities = refs.cities;
    if (refs.coAuthors) data.coAuthors = refs.coAuthors;
    for (const [k, b] of Object.entries(v.flags ?? {})) data[k] = b;
    if (v.sponsor != null) data.sponsor = v.sponsor;

    let created: Doc;
    try {
      created = (await payload.create({
        collection: "articles",
        // D6 (P5.1b): save in Payload draft mode, like the PATCH below — a draft needs only a
        // title; Payload's field validators (pillar required, author) run again at publish.
        draft: true,
        data: data as never,
        depth: 0,
        overrideAccess: true,
        context: { hubAuthor: { actor: v.actor, action: "create" }, engineId: engine.id, disableRevalidate: true },
      })) as unknown as Doc;
    } catch (err) {
      return writeFailed(payload, engine.id, tenant.id, v.slug, err);
    }

    return json(
      {
        ok: true,
        id: created.id,
        tenant: tenant.slug,
        slug: (created.slug as string | undefined) ?? v.slug,
        workflowStatus: "draft",
        version: typeof created.version === "number" ? created.version : 1,
      },
      201,
    );
  } catch (err) {
    return logInternal(payload, engine.id, err);
  }
}

// ── PATCH (update) ───────────────────────────────────────────────────────────

export function handleHubDraftUpdate(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleHubDraftUpdateWith(request, ctx);
}

/** E7: the main row must still be a manual draft right before the write. */
export function assertStillEditable(mainDoc: Doc | null | undefined): { ok: true } | { ok: false; reason: "status" } {
  return mainDoc && mainDoc.origin === "manual" && mainDoc.workflowStatus === "draft" ? { ok: true } : { ok: false, reason: "status" };
}

function gateReason(doc: Doc | null): "origin" | "status" | null {
  if (!doc || doc.origin !== "manual") return "origin";
  if (doc.workflowStatus !== "draft") return "status";
  return null;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(toId(x))) : []);
const sameIds = (a: Id[] | undefined, b: unknown) => JSON.stringify((a ?? []).map(String)) === JSON.stringify(ids(b));
const idOrNull = (v: unknown): string | null => {
  const id = toId(v);
  return id == null ? null : String(id);
};

function secondaryKey(rows: { pillar: Id; subSection?: Id | null }[] | unknown): string {
  if (!Array.isArray(rows)) return "[]";
  return JSON.stringify(
    (rows as { pillar?: unknown; subSection?: unknown }[]).map((r) => [idOrNull(r?.pillar), idOrNull(r?.subSection)]),
  );
}

/** Merge rules on (latest ⊕ patch) — 422 codes of the closed list (E2). */
function mergeRules(v: HubDraftInput, refs: ResolvedRefs, latest: Doc): HubFieldErrors {
  const fields: HubFieldErrors = {};
  const pillarChanged = refs.pillar !== undefined && idOrNull(refs.pillar) !== idOrNull(latest.pillar);
  // D4 (P5.1b): a draft with neither a pillar nor a sub-section yet may set its FIRST pillar without subSectionSlug.
  if (pillarChanged && v.subSectionSlug === undefined && (latest.pillar != null || latest.subSection != null)) fields.subSectionSlug = "required";
  const primary = refs.pillar !== undefined ? idOrNull(refs.pillar) : idOrNull(latest.pillar);
  const secondary =
    refs.secondarySections ??
    (Array.isArray(latest.secondarySections) ? (latest.secondarySections as { pillar?: unknown }[]) : []);
  if (secondary.some((r) => idOrNull((r as { pillar?: unknown }).pillar) === primary)) fields.secondary = "duplicate";
  const sponsored = v.flags?.sponsored ?? latest.sponsored === true;
  const sponsor = v.sponsor !== undefined ? v.sponsor : (latest.sponsor as string | null | undefined);
  if (sponsored && !sponsor) fields.sponsor = "required";
  return fields;
}

export async function handleHubDraftUpdateWith(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
  deps?: HubDraftDeps,
): Promise<Response> {
  const { id } = await ctx.params;
  const payload = await (deps?.getPayload ?? defaultGetPayload)();
  const auth = await (deps?.authenticate ?? authenticateHubAuthorEngine)({ payload, request });
  if (!auth.ok) return auth.response;
  const engine = auth.engine;
  const findMain = deps?.findMain ?? defaultFindMain;

  try {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const parsed = parseUpdateBody(body.raw);
    if (!parsed.ok) return parsedResponse(parsed);
    const v = parsed.value;

    const t = await resolveTenant(payload, auth, v.tenant);
    if (!t.ok) return t.response;
    const tenant = t.tenant;

    if (!isHubArticleId(id)) return notFound();
    const articleId = Number(id);
    const latest = (await payload.findByID({
      collection: "articles",
      id: articleId,
      draft: true,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })) as unknown as Doc | null;
    if (!latest || String(toId(latest.tenant)) !== String(tenant.id)) return notFound();
    const main = await findMain(payload, articleId);
    if (!main || String(toId(main.tenant)) !== String(tenant.id)) return notFound();

    const reason = gateReason(main) ?? gateReason(latest);
    if (reason) return notEditable(reason);
    if (!(await isHubAuthoredDoc(payload, latest))) return notEditable("not_hub_authored");

    const currentVersion = typeof latest.version === "number" ? latest.version : 0;
    if (v.expectedVersion !== currentVersion) return versionConflict(currentVersion);

    if (v.bodyMarkdown !== undefined) {
      const editorConfig = (await loadHubEditorConfig(payload.config)) as HubEditorConfig;
      if (!isRoundTripSafeBody(editorConfig, latest.body)) return bodyNotEditable();
    }

    const refsR = await resolveDraftRefs({ payload, tenant, input: v, currentPillarId: toId(latest.pillar) ?? null });
    if (!refsR.ok) return invalid(refsR.fields);
    const refs = refsR.refs;

    const merge = mergeRules(v, refs, latest);
    if (Object.keys(merge).length) return invalid(merge);

    let lexical: unknown = undefined;
    if (v.bodyMarkdown) {
      const c = await (deps?.convert ?? defaultConvert)(payload, v.bodyMarkdown);
      if (!c.ok) return conversionRejected(payload, c);
      lexical = c.lexical;
    }

    // What changes, by REQUEST key name (E11 c), against the latest version.
    const data: Doc = {};
    const changed: HubDraftFieldKey[] = [];
    const mark = (k: HubDraftFieldKey) => {
      if (!changed.includes(k)) changed.push(k);
    };
    for (const k of v.present) {
      switch (k) {
        case "title":
          if (v.title !== latest.title) {
            data.title = v.title;
            mark(k);
          }
          break;
        case "slug":
          if (v.slug !== latest.slug) {
            data.slug = v.slug;
            mark(k);
          }
          break;
        case "dek":
          if ((v.dek ?? null) !== ((latest.dek as string | null | undefined) ?? null)) {
            data.dek = v.dek ?? null;
            mark(k);
          }
          break;
        case "bodyMarkdown": {
          const nowEmpty = isEmptyBody(latest.body);
          const differs = lexical === undefined ? !nowEmpty : nowEmpty || !lexicalTreesEqual(lexical, latest.body);
          if (differs) {
            data.body = lexical ?? null;
            mark(k);
          }
          break;
        }
        case "takeaways": {
          const joined = v.takeaways && v.takeaways.length ? v.takeaways.join("\n") : null;
          if (joined !== ((latest.takeaways as string | null | undefined) || null)) {
            data.takeaways = joined;
            mark(k);
          }
          break;
        }
        case "readMin":
          if (v.readMin !== latest.readMin) {
            data.readMin = v.readMin;
            mark(k);
          }
          break;
        case "pillarSlug":
          if (idOrNull(refs.pillar) !== idOrNull(latest.pillar)) {
            data.pillar = refs.pillar;
            mark(k);
          }
          break;
        case "subSectionSlug":
          if (idOrNull(refs.subSection) !== idOrNull(latest.subSection)) {
            data.subSection = refs.subSection ?? null;
            mark(k);
          }
          break;
        case "secondary":
          if (secondaryKey(refs.secondarySections) !== secondaryKey(latest.secondarySections)) {
            data.secondarySections = refs.secondarySections;
            mark(k);
          }
          break;
        case "tagSlugs":
          if (!sameIds(refs.tags, latest.tags)) {
            data.tags = refs.tags;
            mark(k);
          }
          break;
        case "countrySlugs":
          if (!sameIds(refs.countries, latest.countries)) {
            data.countries = refs.countries;
            data.country = refs.countries?.[0] ?? null;
            mark(k);
          }
          break;
        case "citySlugs":
          if (!sameIds(refs.cities, latest.cities)) {
            data.cities = refs.cities;
            mark(k);
          }
          break;
        case "authorId":
          if (idOrNull(refs.author) !== idOrNull(latest.author)) {
            data.author = refs.author;
            mark(k);
          }
          break;
        case "coAuthorIds":
          if (!sameIds(refs.coAuthors, latest.coAuthors)) {
            data.coAuthors = refs.coAuthors;
            mark(k);
          }
          break;
        case "flags":
          for (const [fk, b] of Object.entries(v.flags ?? {})) {
            if ((latest[fk] === true) !== b) {
              data[fk] = b;
              mark(k);
            }
          }
          break;
        case "sponsor":
          if ((v.sponsor ?? null) !== ((latest.sponsor as string | null | undefined) ?? null)) {
            data.sponsor = v.sponsor ?? null;
            mark(k);
          }
          break;
      }
    }

    if (data.slug !== undefined && (await findSlugConflict({ payload, tenantId: tenant.id, slug: v.slug as string, excludeId: articleId }))) {
      return slugConflictResponse(payload, tenant.id, v.slug, articleId);
    }

    if (changed.length === 0) {
      return json({ ok: true, id: latest.id, tenant: tenant.slug, workflowStatus: "draft", version: currentVersion, changed: [] }, 200);
    }

    // Right before the write: the main row must STILL be a manual draft (narrows,
    // does not close, the check-then-write gap — `hub-p5-1-patch-check-then-write-not-atomic`).
    const still = assertStillEditable(await findMain(payload, articleId));
    if (!still.ok) return notEditable(still.reason);

    let updated: Doc;
    try {
      updated = (await payload.update({
        collection: "articles",
        id: articleId,
        draft: true,
        data: { ...data, workflowStatus: "draft", _status: "draft" } as never,
        depth: 0,
        overrideAccess: true,
        context: { hubAuthor: { actor: v.actor, action: "update", fields: changed }, engineId: engine.id, disableRevalidate: true },
      })) as unknown as Doc;
    } catch (err) {
      return writeFailed(payload, engine.id, tenant.id, v.slug, err, articleId);
    }

    return json(
      {
        ok: true,
        id: updated.id ?? latest.id,
        tenant: tenant.slug,
        workflowStatus: "draft",
        version: typeof updated.version === "number" ? updated.version : currentVersion + 1,
        changed,
      },
      200,
    );
  } catch (err) {
    return logInternal(payload, engine.id, err);
  }
}
