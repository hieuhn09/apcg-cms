/**
 * Engine hero replace (media-gtp-vowasia phase 5, `POST /api/engine/articles/hero`): the
 * pure pieces. No I/O, no Payload import, so `npm run test:engine-hero` runs them with no DB.
 *
 * - `parseHeroReplaceBody`  request body -> typed value, or the list of bad field names.
 * - `validateHeroFetchUrl`  string-level SSRF guard (scheme, userinfo, literal private
 *                           addresses, internal names, optional exact host allowlist).
 * - `isBlockedAddress`      private / loopback / link-local / metadata / multicast check,
 *                           used for literal hosts here and for DNS answers by the upload helper.
 * - `sniffImageType`        magic bytes (JPEG / PNG / WebP); the response header is not trusted.
 * - `heroToken` / `heroFilenameFor` / `filenameHasHeroToken`  idempotency token (P2): the
 *                           first 8 hex chars of sha256(replacementKey), embedded in the new
 *                           Media filename as `-r<token>`.
 * - `heroGateReason` / `heroPostWriteCheck`  the draft-diverged gate and the post-write
 *                           assertion (P9/P17). They are NOT the hub-live functions: those
 *                           assume a hub-authored published row and `version + 1`.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { parseImageCaption } from "@/lib/intake-hero-caption";
import { liveDiffKeys } from "@/lib/hub-author-live-pure";

type Doc = Record<string, unknown>;

export const HERO_BODY_MAX_BYTES = 16 * 1024;
export const HERO_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const HERO_FETCH_TIMEOUT_MS = 15_000;
export const HERO_ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type HeroImageType = (typeof HERO_ALLOWED_TYPES)[number];
const REPLACEMENT_KEY_MAX = 120;
const REASON_MAX = 200;
const ENGINE_DRAFT_ID_MAX = 300;

// ── Body ─────────────────────────────────────────────────────────────────────

export interface HeroReplaceInput {
  publicationId: string | undefined;
  engineDraftId: string;
  expectedHeroMediaId: number | null;
  heroImageUrl: string | null;
  imageCredit: string | null;
  imageCaption: string | null;
  replacementKey: string | null;
  reason: string | null;
  dryRun: boolean;
}

export type HeroParseResult = { ok: true; value: HeroReplaceInput } | { ok: false; fields: string[] };

const isObj = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isMediaId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function parseHeroReplaceBody(raw: unknown): HeroParseResult {
  if (!isObj(raw)) return { ok: false, fields: ["body"] };
  const bad: string[] = [];

  let dryRun = false;
  if (raw.dryRun !== undefined) {
    if (typeof raw.dryRun === "boolean") dryRun = raw.dryRun;
    else bad.push("dryRun");
  }

  let publicationId: string | undefined;
  if (raw.publicationId !== undefined && raw.publicationId !== null) {
    if (nonEmpty(raw.publicationId)) publicationId = raw.publicationId.trim();
    else bad.push("publicationId");
  }

  const engineDraftId = nonEmpty(raw.engineDraftId) && raw.engineDraftId.length <= ENGINE_DRAFT_ID_MAX ? raw.engineDraftId.trim() : "";
  if (!engineDraftId) bad.push("engineDraftId");

  let expectedHeroMediaId: number | null = null;
  if (!Object.prototype.hasOwnProperty.call(raw, "expectedHeroMediaId")) bad.push("expectedHeroMediaId");
  else if (raw.expectedHeroMediaId === null) expectedHeroMediaId = null;
  else if (isMediaId(raw.expectedHeroMediaId)) expectedHeroMediaId = raw.expectedHeroMediaId;
  else bad.push("expectedHeroMediaId");

  let heroImageUrl: string | null = null;
  if (nonEmpty(raw.heroImageUrl)) heroImageUrl = raw.heroImageUrl.trim();
  else if (!dryRun || raw.heroImageUrl !== undefined) {
    if (!dryRun || raw.heroImageUrl !== null) bad.push("heroImageUrl");
  }

  let replacementKey: string | null = null;
  if (typeof raw.replacementKey === "string" && raw.replacementKey.length >= 1 && raw.replacementKey.length <= REPLACEMENT_KEY_MAX && raw.replacementKey.trim() !== "") {
    replacementKey = raw.replacementKey;
  } else if (!dryRun || raw.replacementKey !== undefined) bad.push("replacementKey");

  let reason: string | null = null;
  if (typeof raw.reason === "string" && raw.reason.trim() !== "" && raw.reason.length <= REASON_MAX) reason = raw.reason.trim();
  else if (!dryRun || raw.reason !== undefined) bad.push("reason");

  let imageCredit: string | null = null;
  if (raw.imageCredit !== undefined && raw.imageCredit !== null) {
    if (typeof raw.imageCredit !== "string") bad.push("imageCredit");
    else imageCredit = raw.imageCredit.trim() || null;
  }

  let imageCaption: string | null = null;
  if (raw.imageCaption !== undefined && raw.imageCaption !== null) {
    if (typeof raw.imageCaption !== "string") bad.push("imageCaption");
    else imageCaption = parseImageCaption(raw.imageCaption);
  }

  if (bad.length) return { ok: false, fields: bad };
  return {
    ok: true,
    value: { publicationId, engineDraftId, expectedHeroMediaId, heroImageUrl, imageCredit, imageCaption, replacementKey, reason, dryRun },
  };
}

// ── SSRF guard ───────────────────────────────────────────────────────────────

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}
function inV4(ip: number, cidr: string): boolean {
  const [b, bits] = cidr.split("/");
  const n = Number(bits);
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return (ip & mask) === (v4ToInt(b as string) & mask);
}
const V4_BLOCKED = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/3",
];

/** Expand an IPv6 literal to 8 hextets (embedded IPv4 tail supported). Null when malformed. */
function v6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    if (isIP(last) !== 4) return null;
    const n = v4ToInt(last);
    tail = [n >>> 16, n & 0xffff];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = parts.length === 2 ? 8 - head.length - rest.length : 0;
  const all = [...head, ...Array(Math.max(0, fill)).fill("0"), ...rest].map((h) => parseInt(h || "0", 16));
  if (all.length !== 8 || all.some((h) => Number.isNaN(h))) return null;
  if (tail.length) {
    all[6] = tail[0] as number;
    all[7] = tail[1] as number;
  }
  return all;
}

export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip.split("%")[0] ?? "");
  if (fam === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some((c) => inV4(n, c)) || n === 0xffffffff;
  }
  if (fam === 6) {
    const h = v6Hextets(ip);
    if (!h) return true;
    const [a, b, c, d, e, f] = h as [number, number, number, number, number, number, number, number];
    if (h.every((x) => x === 0)) return true; // ::
    if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
    // IPv4-mapped / -compatible / NAT64: judge the embedded IPv4 address.
    if ((a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) || (a === 0x64 && b === 0xff9b)) {
      const v4 = `${(h[6]! >> 8) & 255}.${h[6]! & 255}.${(h[7]! >> 8) & 255}.${h[7]! & 255}`;
      return isBlockedAddress(v4);
    }
    if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((a & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
    if ((a & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (a === 0x2001 && b === 0x0db8) return true; // documentation
    return false;
  }
  return true; // not an address at all: never trust it
}

const INTERNAL_NAMES = [/^localhost$/, /\.localhost$/, /^metadata(\.google\.internal)?$/, /\.internal$/, /\.local$/];

export type HeroUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function validateHeroFetchUrl(raw: string, o: { allowLocal: boolean; hosts: readonly string[] }): HeroUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a URL" };
  }
  if (url.protocol !== "https:" && !(o.allowLocal && url.protocol === "http:")) return { ok: false, reason: "scheme not allowed" };
  if (url.username || url.password) return { ok: false, reason: "userinfo not allowed" };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "empty host" };
  if (!o.allowLocal) {
    if (isIP(host) && isBlockedAddress(host)) return { ok: false, reason: "private address" };
    if (INTERNAL_NAMES.some((re) => re.test(host))) return { ok: false, reason: "internal host" };
  }
  if (o.hosts.length && !o.hosts.includes(host)) return { ok: false, reason: "host not allowed" };
  return { ok: true, url };
}

// ── Magic bytes ──────────────────────────────────────────────────────────────

export function sniffImageType(b: Uint8Array): HeroImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "image/webp";
  return null;
}

// ── Idempotency token (P2) ───────────────────────────────────────────────────

export function heroToken(replacementKey: string): string {
  return createHash("sha256").update(replacementKey, "utf8").digest("hex").slice(0, 8);
}

export function heroFilenameFor(slug: string, replacementKey: string, ext: string): string {
  const safe = (slug || "").replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "hero";
  return `${safe}-r${heroToken(replacementKey)}.${ext}`;
}

/** True when the filename carries `-r<token>` followed by `.` or `-` (Payload may append `-1`). */
export function filenameHasHeroToken(filename: string | null | undefined, replacementKey: string): boolean {
  if (typeof filename !== "string" || !filename) return false;
  return new RegExp(`-r${heroToken(replacementKey)}(?=[.-])`).test(filename);
}

// ── Gate + post-write check (P9 / P17) ───────────────────────────────────────

const versionOf = (d: Doc): number => (typeof d.version === "number" ? d.version : 0);

/**
 * `main` = the main row (what the public reads); `latest` = `findByID(draft:true)`.
 * Published main: the latest version must be the same published version. Main row in
 * `_status:"draft"` (pending_review, and the ~3,300 imported legacy rows that are
 * `_status:"draft"` + `workflowStatus:"published"`): the latest version must carry the
 * main row's version (no newer draft on top of it).
 */
export function heroGateReason(main: Doc, latest: Doc | null | undefined): "draft_diverged" | null {
  const l = latest ?? main;
  if (main._status === "published") {
    return l._status !== "published" || versionOf(l) !== versionOf(main) ? "draft_diverged" : null;
  }
  return versionOf(l) !== versionOf(main) ? "draft_diverged" : null;
}

export type HeroPostWriteResult = { ok: true } | { ok: false; reason: string; detail: string[] };

const sameScalar = (a: unknown, b: unknown): boolean => {
  if (a == null && b == null) return true;
  if (a instanceof Date || b instanceof Date || typeof a === "string" || typeof b === "string") {
    const ta = a == null ? NaN : new Date(a as string).getTime();
    const tb = b == null ? NaN : new Date(b as string).getTime();
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb;
  }
  return a === b;
};

export function heroPostWriteCheck(a: { pre: Doc; post: Doc | null | undefined; latestAfter: Doc | null | undefined }): HeroPostWriteResult {
  const { pre, post, latestAfter } = a;
  if (!post || !latestAfter) return { ok: false, reason: "missing", detail: [!post ? "post" : "latestAfter"] };
  const strict: string[] = [];
  if (versionOf(post) !== versionOf(pre)) strict.push("version");
  if (post._status !== pre._status) strict.push("_status");
  if (post.workflowStatus !== pre.workflowStatus) strict.push("workflowStatus");
  if (!sameScalar(post.publishedAt, pre.publishedAt)) strict.push("publishedAt");
  if (strict.length) return { ok: false, reason: "status", detail: strict };
  const diff = liveDiffKeys(pre, post, ["heroImage"]);
  if (diff.length) return { ok: false, reason: "diff", detail: diff };
  if (latestAfter._status !== post._status || versionOf(latestAfter) !== versionOf(post)) {
    return { ok: false, reason: "latest", detail: ["_status", "version"] };
  }
  return { ok: true };
}

/** The Media id of an upload field read at any depth (number, numeric string, or `{id}`). */
export function mediaIdOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  if (isObj(v)) return mediaIdOf(v.id);
  return null;
}
