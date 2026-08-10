/**
 * Newsletter subscriber state for the token's tenant — the write/read surface
 * behind world-travel-brief's /api/subscribe, /api/unsubscribe and /account
 * newsletter preferences after the 08-2026 auth-central migration (WTB's local
 * Payload `subscribers` collection moves here; see Subscribers.ts).
 *
 * Read-token authed like every /api/public route: the token implies the tenant,
 * and these calls only ever come from the site's SERVER (route handlers /
 * server actions) — never from the browser. Email sending stays on the site
 * side; this endpoint only stores state and returns the row (incl. the
 * unsubscribe token so the site can build its one-click link).
 *
 *   GET  ?email=…   → { ok, found, status, newsletters: [slug], token }
 *   GET  ?token=…   → same, looked up by unsubscribe token
 *   POST body:
 *     { email, set: [slug], locale? }        — replace the whole selection and
 *                                              mark subscribed (public subscribe
 *                                              form semantics; empty set allowed)
 *     { email, add?: [slug], remove?: [slug] } — toggle newsletters; status
 *                                              derived: ≥1 → subscribed, 0 →
 *                                              unsubscribed (account toggle)
 *     { token, unsubscribe: true }           — one-click unsubscribe by token
 *   → { ok, status, newsletters: [slug], token }
 */
import { randomBytes } from "node:crypto";
import { getPayload } from "payload";
import config from "@payload-config";
import { resolveReadToken, jsonPublic, preflight } from "@/lib/public";
import { scopedCreate, scopedFind, scopedUpdate } from "@/lib/scoped";
import { featureEnabled } from "@/lib/tenant";
import type { Payload } from "payload";
import type { TenantDoc } from "@/lib/tenant";

export function OPTIONS(request: Request) {
  return preflight(request);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type SubscriberRow = {
  id: number | string;
  email: string;
  status?: "subscribed" | "unsubscribed" | null;
  token?: string | null;
  newsletters?: (number | string | { id: number | string; slug?: string })[] | null;
};

async function findRow(
  payload: Payload,
  tenant: TenantDoc,
  where: { email?: string; token?: string },
): Promise<SubscriberRow | null> {
  const cond: import("payload").Where = where.email
    ? { email: { equals: where.email } }
    : { token: { equals: where.token ?? "" } };
  const res = await scopedFind({
    payload,
    collection: "subscribers",
    tenantId: tenant.id,
    where: cond,
    limit: 1,
    depth: 0,
  });
  return (res.docs[0] as SubscriberRow | undefined) ?? null;
}

/** Resolve this tenant's newsletter ids ↔ slugs (small set, one query). */
async function newsletterMap(payload: Payload, tenant: TenantDoc) {
  const res = await scopedFind({
    payload,
    collection: "newsletters",
    tenantId: tenant.id,
    limit: 100,
    depth: 0,
  });
  const idBySlug = new Map<string, number | string>();
  const slugById = new Map<string, string>();
  for (const d of res.docs as { id: number | string; slug?: string }[]) {
    if (!d.slug) continue;
    idBySlug.set(d.slug, d.id);
    slugById.set(String(d.id), d.slug);
  }
  return { idBySlug, slugById };
}

function rowIds(row: SubscriberRow | null): (number | string)[] {
  if (!row?.newsletters) return [];
  return row.newsletters.map((n) => (typeof n === "object" ? n.id : n));
}

function shape(
  row: SubscriberRow | null,
  slugById: Map<string, string>,
): { found: boolean; status: string; newsletters: string[]; token: string | null } {
  if (!row) return { found: false, status: "none", newsletters: [], token: null };
  return {
    found: true,
    status: row.status ?? "subscribed",
    newsletters: rowIds(row)
      .map((id) => slugById.get(String(id)))
      .filter((s): s is string => Boolean(s)),
    token: row.token ?? null,
  };
}

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config });
  const tenant = await resolveReadToken(payload, request);
  if (!tenant) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);
  if (!featureEnabled(tenant, "newsletters")) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  const url = new URL(request.url);
  const email = url.searchParams.get("email")?.trim().toLowerCase();
  const token = url.searchParams.get("token")?.trim();
  if (!email && !token) return jsonPublic(request, { ok: false, status: "bad_request" }, 400);

  const row = await findRow(payload, tenant, email ? { email } : { token: token! });
  const { slugById } = await newsletterMap(payload, tenant);
  return jsonPublic(request, { ok: true, ...shape(row, slugById) }, 200);
}

export async function POST(request: Request): Promise<Response> {
  const payload = await getPayload({ config });
  const tenant = await resolveReadToken(payload, request);
  if (!tenant) return jsonPublic(request, { ok: false, status: "unauthorized" }, 401);
  if (!featureEnabled(tenant, "newsletters")) return jsonPublic(request, { ok: false, status: "not_found" }, 404);

  let body: {
    email?: unknown;
    token?: unknown;
    set?: unknown;
    add?: unknown;
    remove?: unknown;
    unsubscribe?: unknown;
    locale?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonPublic(request, { ok: false, status: "bad_request" }, 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const linkToken = typeof body.token === "string" ? body.token.trim() : "";
  const locale = typeof body.locale === "string" ? body.locale : undefined;
  const slugsOf = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : null;
  const setSlugs = slugsOf(body.set);
  const addSlugs = slugsOf(body.add) ?? [];
  const removeSlugs = slugsOf(body.remove) ?? [];

  const { idBySlug, slugById } = await newsletterMap(payload, tenant);

  // One-click unsubscribe by token — status flip only, selection kept.
  if (body.unsubscribe === true) {
    if (!linkToken) return jsonPublic(request, { ok: false, status: "bad_request" }, 400);
    const row = await findRow(payload, tenant, { token: linkToken });
    if (!row) return jsonPublic(request, { ok: false, status: "not_found" }, 404);
    await scopedUpdate({
      payload,
      collection: "subscribers",
      tenantId: tenant.id,
      id: row.id,
      data: { status: "unsubscribed" },
    });
    return jsonPublic(request, { ok: true, ...shape({ ...row, status: "unsubscribed" }, slugById) }, 200);
  }

  if (!EMAIL_RE.test(email)) return jsonPublic(request, { ok: false, status: "bad_request" }, 400);
  const row = await findRow(payload, tenant, { email });

  // Next newsletter id set. `set` replaces (subscribe-form semantics, unknown
  // slugs dropped leniently — mirrors WTB's /api/subscribe); add/remove toggles.
  let nextIds: (number | string)[];
  let status: "subscribed" | "unsubscribed";
  if (setSlugs !== null) {
    nextIds = setSlugs.map((s) => idBySlug.get(s)).filter((v): v is number | string => v != null);
    status = "subscribed";
  } else {
    const next = new Set(rowIds(row).map(String));
    for (const s of addSlugs) {
      const id = idBySlug.get(s);
      if (id != null) next.add(String(id));
    }
    for (const s of removeSlugs) {
      const id = idBySlug.get(s);
      if (id != null) next.delete(String(id));
    }
    nextIds = Array.from(next).map((v) => (Number.isNaN(Number(v)) ? v : Number(v)));
    status = nextIds.length ? "subscribed" : "unsubscribed";
  }

  const token = row?.token ?? randomBytes(16).toString("hex");
  const data = {
    newsletters: nextIds,
    status,
    token,
    ...(locale !== undefined ? { locale } : {}),
    subscribedAt: new Date().toISOString(),
  };

  let saved: SubscriberRow;
  if (row) {
    saved = (await scopedUpdate({
      payload,
      collection: "subscribers",
      tenantId: tenant.id,
      id: row.id,
      data,
    })) as unknown as SubscriberRow;
  } else {
    saved = (await scopedCreate({
      payload,
      collection: "subscribers",
      tenantId: tenant.id,
      data: { email, ...data },
    })) as unknown as SubscriberRow;
  }

  return jsonPublic(request, { ok: true, ...shape(saved, slugById) }, 200);
}
