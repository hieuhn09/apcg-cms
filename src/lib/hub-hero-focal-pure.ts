/**
 * Hero focal point — PURE helpers (content-engine plan
 * process/features/apcg-hub/active/hub-hero-focal-point_PLAN_10-11-26.md, P1.1; D1, D8, D13, D15).
 * No I/O, no Payload, no `@payload-config`.
 *
 * The focal point lives on the MEDIA doc (Payload's built-in `focalX` / `focalY`, percent 0-100,
 * columns `focal_x` / `focal_y` exist since the initial schema; no migration). The hub sends it as
 * the closed draft / live key `heroFocal: {x, y} | null` with the article save; the CMS writes it on
 * the article's hero media AFTER the article lock commits (`hub-hero-focal-core.ts`).
 *
 *   parseHeroFocal         — the request value → {x, y} | null, or ONE closed `HubFieldCode`
 *   focalTenants           — the CMS switch `HUB_FOCAL_TENANTS` (CSV of tenant slugs, default OFF)
 *   focalToColumns         — {x, y} | null → {focalX, focalY}; null ⇒ 50/50 (never NULL columns)
 *   isUnsetFocal           — (50, 50) = "not set" (Payload writes 50/50 on every media create)
 *   focalColumnsChanged    — the media hook's "real change" test
 */

import type { HubFieldCode } from "@/lib/hub-author-limits";

export interface HubHeroFocal {
  x: number;
  y: number;
}

/** D8: the only "centre" shape ever written. */
export const HERO_FOCAL_CENTRE = 50;
export const HERO_FOCAL_MIN = 0;
export const HERO_FOCAL_MAX = 100;
/** D10: the only warning a focal save can add to a 2xx body. */
export const HERO_FOCAL_NOT_APPLIED = "hero_focal_not_applied";
/** The keys of a `heroFocal` object (unknown inner keys ⇒ 400, like `flags` / `actor`). */
export const HERO_FOCAL_KEYS: readonly string[] = ["x", "y"];

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * One axis: absent ⇒ `required`; not a finite integer number (string, 50.5, NaN, Infinity) ⇒
 * `type`; an integer outside 0..100 ⇒ `out_of_range`.
 */
function checkAxis(o: Record<string, unknown>, k: "x" | "y"): { ok: true; value: number } | { ok: false; code: HubFieldCode } {
  if (!Object.prototype.hasOwnProperty.call(o, k)) return { ok: false, code: "required" };
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v)) return { ok: false, code: "type" };
  if (v < HERO_FOCAL_MIN || v > HERO_FOCAL_MAX) return { ok: false, code: "out_of_range" };
  return { ok: true, value: v };
}

/**
 * The `heroFocal` request value (already JSON-parsed; unknown inner keys were refused with a 400
 * by the parser before this runs). `null` = back to the centre. Not a plain object ⇒ `type`;
 * then `x`, then `y` (first failure wins, one code for the whole field).
 */
export function parseHeroFocal(v: unknown): { ok: true; value: HubHeroFocal | null } | { ok: false; code: HubFieldCode } {
  if (v === null) return { ok: true, value: null };
  if (!isPlainObject(v)) return { ok: false, code: "type" };
  const x = checkAxis(v, "x");
  if (!x.ok) return x;
  const y = checkAxis(v, "y");
  if (!y.ok) return y;
  return { ok: true, value: { x: x.value, y: y.value } };
}

/**
 * D15 / D19: `HUB_FOCAL_TENANTS` — CSV of CMS tenant slugs (e.g. `gtp`), default OFF. Read on
 * EVERY call (no cache); split on ",", trim, drop empty items; the caller matches EXACTLY.
 */
export function focalTenants(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.HUB_FOCAL_TENANTS;
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function isFocalTenant(slug: string | null | undefined, tenants: readonly string[]): boolean {
  return typeof slug === "string" && tenants.includes(slug);
}

/** D8: the media columns to write. `null` ⇒ the centre 50/50 (never NULL). */
export function focalToColumns(f: HubHeroFocal | null): { focalX: number; focalY: number } {
  return f ? { focalX: f.x, focalY: f.y } : { focalX: HERO_FOCAL_CENTRE, focalY: HERO_FOCAL_CENTRE };
}

/** D13: (50, 50) is "not set" — Payload stamps it on every new media doc. */
export function isUnsetFocal(x: unknown, y: unknown): boolean {
  return x === HERO_FOCAL_CENTRE && y === HERO_FOCAL_CENTRE;
}

const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The media doc already carries exactly these columns (no write needed). */
export function focalColumnsEqual(doc: Record<string, unknown>, cols: { focalX: number; focalY: number }): boolean {
  return asNum(doc.focalX) === cols.focalX && asNum(doc.focalY) === cols.focalY;
}

/** D11 / P1.5: the media hook fires only when `focalX` or `focalY` really changed (numeric compare; null ≠ 50). */
export function focalColumnsChanged(doc: Record<string, unknown> | null | undefined, previous: Record<string, unknown> | null | undefined): boolean {
  if (!doc || !previous) return false;
  return asNum(doc.focalX) !== asNum(previous.focalX) || asNum(doc.focalY) !== asNum(previous.focalY);
}
