/**
 * GET /api/hub/taxonomy — READ-ONLY pillars + authors per publication for
 * APCGHub (APCGHub P4 / CMS-2; Newsroom screen).
 *
 *   Auth:   Authorization: Bearer <token of a ContentEngines doc with hubRead:true>
 *   Query:  tenants  CSV of tenant slugs, SUBSET of the engine's grant; outside
 *                    it ⇒ 403. Absent ⇒ every allowed tenant.
 *           kinds    CSV ⊆ {pillars, authors}; absent ⇒ both. Unknown ⇒ 400.
 *
 * Empty/absent tenants|pillar|kinds means ALL allowed — callers must never send
 * an empty scope by accident (Hub-1 lesson D0).
 *
 * NEVER SILENTLY CUT: Payload's default page size is 10, so every query carries
 * an explicit `limit: CAP + 1`. More than CAP rows ⇒ the list is cut to CAP and
 * `truncated: true`; `totalDocs` is the true count Payload reports.
 * Pillars/Authors are not feature-gated (plain `tenantManagedAccess`), so no
 * `features.*` check is needed here. Output is an allowlist (`hub-sanitize.ts`);
 * `Authors.user` (→ Users e-mail) is never selected. Localized text is `en`.
 *
 * WRITES: none in this route. `authenticateHubEngine` (as in CMS-1) updates the
 * engine's lastSeenAt/lastSeenIp and writes ActivityLog on auth failures; this
 * route adds ActivityLog rows only for `engine_tenant_denied` / `integration_error`.
 */

import { getPayload } from "payload";
import config from "@payload-config";
import { authenticateHubEngine, narrowHubTenants } from "@/lib/hub-auth";
import { scopedFind } from "@/lib/scoped";
import { parseKinds } from "@/lib/hub-query";
import {
  AUTHOR_SELECT,
  PILLAR_SELECT,
  sanitizeHubAuthor,
  sanitizeHubPillar,
  type HubAuthor,
  type HubPillar,
} from "@/lib/hub-sanitize";
import { json } from "@/lib/http";
import { logActivity } from "@/lib/activity";

const PILLARS_CAP = 200;
const AUTHORS_CAP = 1000;

interface Block<T> {
  items: T[];
  count: number;
  totalDocs: number;
  truncated: boolean;
}

function block<T>(docs: Record<string, unknown>[], totalDocs: number, cap: number, sanitize: (d: Record<string, unknown>) => T): Block<T> {
  const items = docs.slice(0, cap).map(sanitize);
  return { items, count: items.length, totalDocs, truncated: docs.length > cap || totalDocs > cap };
}

export async function GET(request: Request): Promise<Response> {
  const payload = await getPayload({ config });

  const auth = await authenticateHubEngine({ payload, request });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const narrowed = narrowHubTenants(auth.tenants, url.searchParams.get("tenants"));
  if (!narrowed.ok) {
    await logActivity({
      payload,
      eventType: "engine_tenant_denied",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: "hub/taxonomy", requested: narrowed.unknown },
    });
    return json(
      { ok: false, status: "forbidden", reason: "tenant not allowed for this engine", tenants: narrowed.unknown },
      403,
    );
  }
  const tenants = narrowed.tenants;

  const kinds = parseKinds(url.searchParams.get("kinds"));
  if (!kinds.ok) {
    return json({ ok: false, status: "bad_request", reason: kinds.reason, values: kinds.values }, 400);
  }
  const wantPillars = kinds.kinds.includes("pillars");
  const wantAuthors = kinds.kinds.includes("authors");

  try {
    const out = await Promise.all(
      tenants.map(async (t) => {
        const [pillars, authors] = await Promise.all([
          wantPillars
            ? scopedFind({
                payload,
                collection: "pillars",
                tenantId: t.id,
                select: PILLAR_SELECT,
                depth: 0,
                locale: "en",
                limit: PILLARS_CAP + 1,
                page: 1,
                sort: ["order", "slug", "id"],
              })
            : null,
          wantAuthors
            ? scopedFind({
                payload,
                collection: "authors",
                tenantId: t.id,
                select: AUTHOR_SELECT,
                depth: 0,
                locale: "en",
                limit: AUTHORS_CAP + 1,
                page: 1,
                sort: ["rank", "name", "id"],
              })
            : null,
        ]);
        const entry: { tenant: string; pillars?: Block<HubPillar>; authors?: Block<HubAuthor> } = { tenant: t.slug };
        if (pillars) {
          entry.pillars = block(pillars.docs as unknown as Record<string, unknown>[], pillars.totalDocs, PILLARS_CAP, sanitizeHubPillar);
        }
        if (authors) {
          entry.authors = block(authors.docs as unknown as Record<string, unknown>[], authors.totalDocs, AUTHORS_CAP, sanitizeHubAuthor);
        }
        return entry;
      }),
    );
    return json({ ok: true, locale: "en", tenants: out }, 200);
  } catch (err) {
    payload.logger.error(`[hub/taxonomy] read failed: ${(err as Error).message}`);
    await logActivity({
      payload,
      eventType: "integration_error",
      actorType: "engine",
      actorEngineId: auth.engine.id,
      detail: { scope: "hub/taxonomy", message: (err as Error).message },
    });
    return json({ ok: false, status: "internal_error" }, 500);
  }
}
