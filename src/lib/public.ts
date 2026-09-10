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

/**
 * How long a resolved (or rejected) read token stays memoized.
 *
 * SECURITY TRADE-OFF — read this before changing it. Memoizing the lookup means
 * token revocation and tenant deactivation are NOT immediate: a token revoked
 * now keeps working for up to this long, on any serverless instance that
 * already cached it. That delay is accepted deliberately, in exchange for
 * removing an uncached `payload.find` on `tenants` from the front of every
 * public request (~2.96M/month, one DB round-trip each, before any article
 * query runs). The window is kept short (well under a minute) so the exposure
 * is bounded and comparable to normal CDN/ISR staleness. If a token is ever
 * revoked in an emergency, treat this TTL as the propagation floor — redeploy
 * to clear every instance's cache immediately.
 */
const READ_TOKEN_TTL_MS = 30_000;

interface CachedTenant {
  tenant: TenantDoc | null;
  expiresAt: number;
}

/**
 * Module-level memo, keyed by the token HASH (never the raw token, so the
 * secret is not held in memory as plaintext beyond the request).
 *
 * Negative results are cached too — otherwise a bad-token flood would still hit
 * the database on every request, which is the exact cost this fix removes.
 *
 * KNOWN GAP (accepted in the plan): concurrent requests can race and each run
 * the same lookup before either writes. That is harmless — the lookup is a
 * pure read, entries are idempotent, and the loser simply overwrites with an
 * equivalent value. Deliberately not solved with an in-flight promise map;
 * this surface is read-mostly with a short TTL and the extra machinery would
 * cost more than the duplicate reads it prevents.
 */
const readTokenCache = new Map<string, CachedTenant>();

/** Resolve the Bearer read token → its tenant (active token + active tenant). */
export async function resolveReadToken(
  payload: Payload,
  request: Request,
): Promise<TenantDoc | null> {
  const raw = bearerToken(request.headers.get("authorization"));
  if (!raw) return null;
  const hash = sha256Hex(raw);

  const now = Date.now();
  const cached = readTokenCache.get(hash);
  if (cached && cached.expiresAt > now) return cached.tenant;

  const tenant = await lookupReadToken(payload, hash);
  readTokenCache.set(hash, { tenant, expiresAt: now + READ_TOKEN_TTL_MS });

  // Drop expired entries opportunistically. Without this the Map grows without
  // bound on a long-lived instance under a rotating-token or bad-token flood.
  if (readTokenCache.size > 1_000) {
    for (const [key, entry] of readTokenCache) {
      if (entry.expiresAt <= now) readTokenCache.delete(key);
    }
  }

  return tenant;
}

/** Uncached lookup. `hash` is the sha256 of the raw bearer token. */
async function lookupReadToken(payload: Payload, hash: string): Promise<TenantDoc | null> {
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
