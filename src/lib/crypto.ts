/**
 * Token + signing primitives:
 *   - sha256Hex / hashToken: hash engine + read tokens at rest (never store raw).
 *   - constantTimeEqual: timing-safe comparison for bearer checks.
 *   - signPayload / verifySigned: HMAC-signed, expiring tokens for preview links
 *     and revalidate webhooks (so a leaked slug or URL alone is not enough).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Hash a bearer token for storage. Prefix (first 8 chars of raw) is stored
 *  separately for human identification in logs/admin. */
export function hashToken(rawToken: string): { hash: string; prefix: string } {
  return { hash: sha256Hex(rawToken), prefix: rawToken.slice(0, 8) };
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract a Bearer token from an Authorization header. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token.length ? token : null;
}

// ── HMAC signed tokens (preview, revalidate) ────────────────────────────────

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export interface SignedClaims {
  [key: string]: unknown;
  /** unix epoch seconds expiry */
  exp: number;
}

function secret(): string {
  const s = process.env.CENTRAL_SIGNING_SECRET;
  if (!s) throw new Error("CENTRAL_SIGNING_SECRET is not set");
  return s;
}

/** Produce a compact `<payload>.<sig>` token. */
export function signPayload(claims: SignedClaims): string {
  const body = b64url(JSON.stringify(claims));
  const sig = b64url(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

/** Verify + decode a signed token. Returns null if tampered or expired. */
export function verifySigned<T extends SignedClaims = SignedClaims>(
  token: string,
  nowSeconds: number,
): T | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = b64url(createHmac("sha256", secret()).update(body).digest());
  if (!constantTimeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(fromB64url(body).toString("utf8")) as T;
    if (typeof claims.exp !== "number" || claims.exp < nowSeconds) return null;
    return claims;
  } catch {
    return null;
  }
}
