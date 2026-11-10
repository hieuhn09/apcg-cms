/**
 * Shared hero-image upload for engine routes (media-gtp-vowasia phase 5).
 *
 * Two entry points over the same fetch + `scopedCreate` media step:
 *
 * - `uploadHeroLenient` — the engine INTAKE create path, moved here unchanged from
 *   `src/app/api/engine/intake/route.ts` (`uploadHero`): `fetch(url)` with no options,
 *   the response content-type trusted (default `image/jpeg`), name `${slug}.${ext}`, any
 *   failure swallowed with the same warn line and `undefined` returned so the article is
 *   created without a hero. Behaviour is pinned by `engine-hero-upload.test.ts`.
 *
 * - `uploadHeroMedia` — the strict path used by `POST /api/engine/articles/hero`. It
 *   REPORTS failure (`{ok:false, code}`) and hardens the fetch (P4 / P15(3)):
 *     DNS lookup of the host, every answer must be public (unless `allowLocal`);
 *     `redirect: "manual"` (any 3xx is `invalid_hero_url`);
 *     `AbortSignal.timeout(timeoutMs)`;
 *     header type must be allowed; the body is STREAMED through a counting reader and
 *     aborted at `maxBytes` (never buffered first; `content-length` is a hint only);
 *     magic bytes must match an allowed type; the sniffed type is what Media stores.
 *   Residual (accepted): DNS rebinding between the lookup and the connect.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Payload } from "payload";
import { scopedCreate } from "@/lib/scoped";
import { buildHeroMediaData } from "@/lib/intake-hero-caption";
import { isBlockedAddress, sniffImageType } from "@/lib/engine-hero-replace-pure";

type Id = number | string;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface HeroUploadDeps {
  fetch?: FetchFn;
  /** Every address the host resolves to (default: `dns.lookup(host, {all:true})`). */
  resolveHost?: (host: string) => Promise<string[]>;
}

export interface HeroUploadOptions {
  maxBytes: number;
  allowedTypes: readonly string[];
  timeoutMs: number;
  sniff: boolean;
  /** Probe-only relaxation of the DNS private-address check. */
  allowLocal: boolean;
  /** Media filename from the sniffed extension (carries the `-r<token>` idempotency token). */
  filenameFor: (ext: string) => string;
}

export type HeroUploadCode = "invalid_hero_url" | "fetch_failed" | "hero_not_an_image" | "hero_too_large" | "upload_failed";
export type HeroUploadResult = { ok: true; id: Id; filename: string } | { ok: false; code: HeroUploadCode; reason: string };

export interface HeroUploadArgs {
  tenantId: Id;
  url: string;
  title: string;
  slug: string;
  credit: string | null;
  caption: string | null;
}

const defaultResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((a) => a.address);

const fail = (code: HeroUploadCode, reason: string): HeroUploadResult => ({ ok: false, code, reason });

/** Read at most `max` bytes; `null` when the stream goes past the cap (the reader is cancelled). */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function uploadHeroMedia(payload: Payload, a: HeroUploadArgs, o: HeroUploadOptions, deps: HeroUploadDeps = {}): Promise<HeroUploadResult> {
  const doFetch: FetchFn = deps.fetch ?? ((u, i) => fetch(u, i));
  let url: URL;
  try {
    url = new URL(a.url);
  } catch {
    return fail("invalid_hero_url", "not a URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (!o.allowLocal) {
    let addrs: string[];
    try {
      addrs = isIP(host) ? [host] : await (deps.resolveHost ?? defaultResolve)(host);
    } catch {
      return fail("fetch_failed", "host did not resolve");
    }
    if (!addrs.length || addrs.some((ip) => isBlockedAddress(ip))) return fail("invalid_hero_url", "host resolves to a private address");
  }

  let res: Response;
  try {
    res = await doFetch(url.toString(), { redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs) });
  } catch (err) {
    return fail("fetch_failed", `hero fetch error (${(err as Error).name})`);
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    return fail("invalid_hero_url", "redirect not allowed");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return fail("fetch_failed", `hero fetch ${res.status}`);
  }
  const headerType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!o.allowedTypes.includes(headerType)) {
    await res.body?.cancel().catch(() => {});
    return fail("hero_not_an_image", `content type ${headerType || "missing"}`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > o.maxBytes) {
    await res.body?.cancel().catch(() => {});
    return fail("hero_too_large", "declared size over the cap");
  }
  let buffer: Buffer | null;
  try {
    buffer = await readCapped(res, o.maxBytes);
  } catch (err) {
    return fail("fetch_failed", `hero read error (${(err as Error).name})`);
  }
  if (buffer === null) return fail("hero_too_large", "body over the cap");

  let mimetype = headerType;
  if (o.sniff) {
    const sniffed = sniffImageType(buffer);
    if (!sniffed || !o.allowedTypes.includes(sniffed)) return fail("hero_not_an_image", "magic bytes do not match an allowed image type");
    mimetype = sniffed;
  }

  const name = o.filenameFor(mimetype.split("/")[1] || "jpg");
  try {
    const media = await scopedCreate({
      payload,
      collection: "media",
      tenantId: a.tenantId,
      data: buildHeroMediaData({ title: a.title, credit: a.credit, caption: a.caption }),
      file: { data: buffer, mimetype, name, size: buffer.length },
    });
    const doc = media as { id: Id; filename?: string | null };
    return { ok: true, id: doc.id, filename: doc.filename ?? name };
  } catch (err) {
    payload.logger.warn(`[engine-hero] media create failed (${(err as Error).message})`);
    return fail("upload_failed", "media create failed");
  }
}

/** The intake create-path behaviour, byte for byte (see the header). */
export async function uploadHeroLenient(
  payload: Payload,
  tenantId: Id,
  url: string,
  title: string,
  slug: string,
  credit: string | null,
  caption: string | null,
  deps: Pick<HeroUploadDeps, "fetch"> = {},
): Promise<Id | undefined> {
  try {
    const res = deps.fetch ? await deps.fetch(url) : await fetch(url);
    if (!res.ok) throw new Error(`hero fetch ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimetype = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    const ext = mimetype.split("/")[1] || "jpg";
    const media = await scopedCreate({
      payload,
      collection: "media",
      tenantId,
      data: buildHeroMediaData({ title, credit, caption }),
      file: { data: buffer, mimetype, name: `${slug}.${ext}`, size: buffer.length },
    });
    return (media as { id: Id }).id;
  } catch (err) {
    payload.logger.warn(`[intake] hero upload failed (${(err as Error).message}) — publishing without hero`);
    return undefined;
  }
}
