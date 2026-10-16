/**
 * POST /api/hub/authors and POST /api/hub/tags — create ONE pen name / ONE tag for one
 * tenant from the hub composer (APCGHub P5.6, chặng 2; content-engine plan
 * process/features/apcg-hub/active/apcg-hub-p5-6-preview-taxonomy-cms-exit_PLAN_30-09-26.md,
 * D11–D16, Public Contracts C-AU / C-TG).
 *
 * Auth = the hub AUTHOR key (hubRead + hubAuthor, `authenticateHubAuthorEngine`, D2).
 * Order (first failure wins): auth (401 / 403 hub read / 403 hub author) → body
 * ≤ 4,096 bytes (413, `readSmallBody`) → JSON (400) → shape / unknown keys (400) and
 * fields (422, closed codes) → tenant ∈ grant (403 + `engine_tenant_denied`) →
 * `features.articles` (403) → LOOKUP (normalised name / tag slug in THAT tenant ⇒ 200
 * `created: false`, even when the tenant is full) → [not found] soft cap (D16, 409
 * `taxonomy_full`) → create → ONE ActivityLog row (`human_edit`, no name / title).
 *
 * Tags: a create that loses a race (the per-tenant slug hook "… already exists for this
 * tenant", or Postgres 23505) re-reads ONCE: found ⇒ 200 `created: false`; not found
 * ⇒ 500 with the fixed body. Authors have no lock around find + create (`scoped.ts`
 * takes no `req`): two concurrent creates of the same name may both create (known gap).
 *
 * Only `scopedFind` / `scopedCreate` (tenant id always from the GRANT, never the body).
 * Responses go through allowlists (`authorView` / `tagView`). Logs: an error NAME and
 * CODE only — never a name, a title or a token. The route wrappers never pass `deps`.
 */

import { getPayload, type Payload } from "payload";
import config from "@payload-config";
import { logActivity } from "@/lib/activity";
import { json } from "@/lib/http";
import { scopedCreate, scopedFind } from "@/lib/scoped";
import { pgErrorCode } from "@/lib/hub-article-lock";
import { authenticateHubAuthorEngine } from "@/lib/hub-author-auth";
import { internalError, logInternal, parsedResponse, resolveTenant } from "@/lib/hub-author-handlers";
import { readSmallBody } from "@/lib/hub-author-preview-pure";
import type { HubActor } from "@/lib/hub-author-input";
import {
  TAXONOMY_SOFT_CAP_AUTHORS,
  TAXONOMY_SOFT_CAP_TAGS,
  authorCreateData,
  authorView,
  parseAuthorBody,
  parseTagBody,
  tagView,
} from "@/lib/hub-taxonomy-create-pure";

type Doc = Record<string, unknown>;
type Id = number | string;

/** Injectable seams (unit checks only; production never passes them). */
export interface HubTaxonomyDeps {
  getPayload?: () => Promise<Payload>;
}

const defaultGetPayload = () => getPayload({ config });

const taxonomyFull = () =>
  json({ ok: false, status: "taxonomy_full", reason: "tenant taxonomy is full; tidy it up in the CMS admin" }, 409);

/** detail of the ActivityLog row: no name, no title, no e-mail (D15). */
function actorDetail(actor: HubActor): Doc {
  return actor.id === undefined ? { role: actor.role } : { role: actor.role, id: actor.id };
}

async function logCreated(payload: Payload, engineId: Id, tenantId: Id, collection: "authors" | "tags", targetId: Id, actor: HubActor) {
  await logActivity({
    payload,
    eventType: "human_edit",
    tenantId,
    actorType: "engine",
    actorEngineId: engineId,
    targetCollection: collection,
    targetId,
    detail: { via: "hub", action: collection === "authors" ? "author_create" : "tag_create", actor: actorDetail(actor), created: true },
  });
}

/** Total rows of a tenant (cheap: limit 1, depth 0, one selected column). */
async function countRows(payload: Payload, collection: "authors" | "tags", tenantId: Id): Promise<number> {
  const r = await scopedFind({
    payload,
    collection,
    tenantId,
    limit: 1,
    depth: 0,
    select: (collection === "authors" ? { name: true } : { slug: true }) as never,
  });
  return r.totalDocs;
}

// ── POST /api/hub/authors ────────────────────────────────────────────────────

export function handleHubAuthorCreate(request: Request): Promise<Response> {
  return handleHubAuthorCreateWith(request);
}

export async function handleHubAuthorCreateWith(request: Request, deps: HubTaxonomyDeps = {}): Promise<Response> {
  const payload = await (deps.getPayload ?? defaultGetPayload)();
  const auth = await authenticateHubAuthorEngine({ payload, request });
  if (!auth.ok) return auth.response;

  const body = await readSmallBody(request);
  if (!body.ok) return body.response;
  const parsed = parseAuthorBody(body.raw);
  if (!parsed.ok) return parsedResponse(parsed);

  const t = await resolveTenant(payload, auth, parsed.value.tenant);
  if (!t.ok) return t.response;
  const tenantId = t.tenant.id;
  const { name, role, actor } = parsed.value;

  try {
    const found = await scopedFind({ payload, collection: "authors", tenantId, where: { name: { equals: name } }, limit: 1, depth: 0 });
    const existing = found.docs[0] as unknown as Doc | undefined;
    if (existing) return json({ ok: true, created: false, author: authorView(existing) }, 200);

    if ((await countRows(payload, "authors", tenantId)) >= TAXONOMY_SOFT_CAP_AUTHORS) return taxonomyFull();

    const created = (await scopedCreate({ payload, collection: "authors", tenantId, data: authorCreateData(name, role) })) as unknown as Doc;
    await logCreated(payload, auth.engine.id, tenantId, "authors", created.id as Id, actor);
    return json({ ok: true, created: true, author: authorView(created) }, 201);
  } catch (err) {
    return logInternal(payload, auth.engine.id, err);
  }
}

// ── POST /api/hub/tags ───────────────────────────────────────────────────────

/** The per-tenant slug hook's message, or Postgres unique violation. */
function isDuplicateTag(err: unknown): boolean {
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.includes("already exists for this tenant")) return true;
  return pgErrorCode(err) === "23505";
}

export function handleHubTagCreate(request: Request): Promise<Response> {
  return handleHubTagCreateWith(request);
}

export async function handleHubTagCreateWith(request: Request, deps: HubTaxonomyDeps = {}): Promise<Response> {
  const payload = await (deps.getPayload ?? defaultGetPayload)();
  const auth = await authenticateHubAuthorEngine({ payload, request });
  if (!auth.ok) return auth.response;

  const body = await readSmallBody(request);
  if (!body.ok) return body.response;
  const parsed = parseTagBody(body.raw);
  if (!parsed.ok) return parsedResponse(parsed);

  const t = await resolveTenant(payload, auth, parsed.value.tenant);
  if (!t.ok) return t.response;
  const tenantId = t.tenant.id;
  const { title, slug, actor } = parsed.value;
  const findBySlug = async () =>
    (await scopedFind({ payload, collection: "tags", tenantId, where: { slug: { equals: slug } }, limit: 1, depth: 0 })).docs[0] as unknown as
      | Doc
      | undefined;

  try {
    const existing = await findBySlug();
    if (existing) return json({ ok: true, created: false, tag: tagView(existing) }, 200);

    if ((await countRows(payload, "tags", tenantId)) >= TAXONOMY_SOFT_CAP_TAGS) return taxonomyFull();

    let created: Doc;
    try {
      created = (await scopedCreate({ payload, collection: "tags", tenantId, data: { slug, title } })) as unknown as Doc;
    } catch (err) {
      if (!isDuplicateTag(err)) throw err;
      const again = await findBySlug();
      if (again) return json({ ok: true, created: false, tag: tagView(again) }, 200);
      payload.logger.error("[hub/tags] create lost a race and the re-read found nothing");
      return internalError();
    }
    await logCreated(payload, auth.engine.id, tenantId, "tags", created.id as Id, actor);
    return json({ ok: true, created: true, tag: tagView(created) }, 201);
  } catch (err) {
    return logInternal(payload, auth.engine.id, err);
  }
}
