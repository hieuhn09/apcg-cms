/**
 * Shared helpers for the public read API (`/api/public/*`):
 *   - resolveReadToken: per-tenant read token → tenant (the Frontend identity).
 *   - corsHeaders / preflight: CORS for cross-origin frontend calls.
 *   - jsonPublic: JSON response with CORS headers attached.
 *
 * The public API only ever returns a tenant its OWN published content. The read
 * token implies the tenant, so callers never pass a tenant and cross-tenant
 * reads are impossible by construction.
 */

import type { Payload } from "payload";
import { bearerToken, sha256Hex } from "@/lib/crypto";
import type { TenantDoc } from "@/lib/tenant";

const allowedOrigins = (process.env.PUBLIC_API_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export function jsonPublic(request: Request, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request.headers.get("origin")) },
  });
}

/** Resolve the Bearer read token → its tenant (active token + active tenant). */
export async function resolveReadToken(
  payload: Payload,
  request: Request,
): Promise<TenantDoc | null> {
  const raw = bearerToken(request.headers.get("authorization"));
  if (!raw) return null;
  const hash = sha256Hex(raw);
  const res = await payload.find({
    collection: "tenants",
    where: { "readTokens.tokenHash": { equals: hash } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  });
  const tenant = res.docs[0] as TenantDoc | undefined;
  if (!tenant || tenant.status !== "active") return null;
  // Verify a matching token row is active (array subfield query matches any row).
  const rows = (tenant as unknown as { readTokens?: { tokenHash?: string; status?: string }[] }).readTokens ?? [];
  const ok = rows.some((r) => r.tokenHash === hash && r.status !== "revoked");
  return ok ? tenant : null;
}
