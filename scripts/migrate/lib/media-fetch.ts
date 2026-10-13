/**
 * Hardened image fetch for the GTP import (gtp-launch P4, A11-S15, 7.5).
 *   - https only, host must be in media.hostAllowlist (re-checked on EVERY hop);
 *   - `redirect: "manual"`, at most 3 hops;
 *   - `content-length` above the cap refused; body STREAMED with a running
 *     byte count and aborted past the cap (never an unbounded arrayBuffer);
 *   - magic bytes must be JPEG/PNG/WebP/GIF/AVIF and match the content-type;
 *     SVG refused;
 *   - media.hostRewrite maps an allow-listed host to a LOCAL target (fixture
 *     only; overlay validation already refused non-local targets).
 */
export type FetchLike = (url: string, init: { redirect: "manual"; signal?: AbortSignal; method?: string }) => Promise<Response>;

export interface FetchOpts {
  allow: readonly string[];
  rewrite: Readonly<Record<string, string>>;
  maxBytes: number;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export type FetchFailure = "invalidUrl" | "hostNotAllowed" | "mediaRedirectBlocked" | "tooManyRedirects" | "tooLarge" | "badMagic" | "mimeMismatch" | "svgRejected" | "timeout" | `http ${number}` | "network";
export type FetchResult = { ok: true; bytes: Buffer; mime: string; finalUrl: string } | { ok: false; reason: FetchFailure; retryable: boolean };

export function sniffMime(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (b.length >= 4 && String.fromCharCode(...b.slice(0, 4)) === "GIF8") return "image/gif";
  if (b.length >= 12 && String.fromCharCode(...b.slice(4, 8)) === "ftyp" && /^avi[fs]/.test(String.fromCharCode(...b.slice(8, 12)))) return "image/avif";
  return null;
}

function normMime(m: string): string {
  const x = m.split(";")[0]?.trim().toLowerCase() ?? "";
  return x === "image/jpg" || x === "image/pjpeg" ? "image/jpeg" : x;
}

function allowed(u: URL, allow: readonly string[]): boolean {
  return u.protocol === "https:" && allow.includes(u.host.toLowerCase());
}

/** The network URL actually fetched: rewritten host -> http://<local target>. */
export function physicalUrl(u: URL, rewrite: Readonly<Record<string, string>>): string {
  const target = rewrite[u.host.toLowerCase()];
  return target ? `http://${target}${u.pathname}${u.search}` : u.toString();
}

export async function fetchImage(rawUrl: string, o: FetchOpts): Promise<FetchResult> {
  const f: FetchLike = o.fetchImpl ?? ((url, init) => fetch(url, init));
  let logical: URL;
  try {
    logical = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalidUrl", retryable: false };
  }
  if (!allowed(logical, o.allow)) return { ok: false, reason: "hostNotAllowed", retryable: false };
  for (let hop = 0; hop <= 3; hop++) {
    let res: Response;
    try {
      res = await f(physicalUrl(logical, o.rewrite), { redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs) });
    } catch (err) {
      const name = (err as Error).name;
      return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", retryable: true };
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, reason: `http ${res.status}`, retryable: false };
      if (hop === 3) return { ok: false, reason: "tooManyRedirects", retryable: false };
      let next: URL;
      try {
        next = new URL(loc, logical);
      } catch {
        return { ok: false, reason: "mediaRedirectBlocked", retryable: false };
      }
      // a redirect to the local rewrite target is expressed in logical space by the fixture server
      if (!allowed(next, o.allow)) return { ok: false, reason: "mediaRedirectBlocked", retryable: false };
      logical = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: `http ${res.status}`, retryable: res.status === 408 || res.status === 429 || res.status >= 500 };
    }
    const len = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(len) && len > o.maxBytes) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: "tooLarge", retryable: false };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, reason: "network", retryable: true };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > o.maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "tooLarge", retryable: false };
        }
        chunks.push(value);
      }
    } catch (err) {
      const name = (err as Error).name;
      return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", retryable: true };
    }
    const bytes = Buffer.concat(chunks);
    const declared = normMime(res.headers.get("content-type") ?? "");
    if (declared === "image/svg+xml") return { ok: false, reason: "svgRejected", retryable: false };
    const sniffed = sniffMime(bytes);
    if (!sniffed) return { ok: false, reason: "badMagic", retryable: false };
    if (declared && declared !== sniffed) return { ok: false, reason: "mimeMismatch", retryable: false };
    return { ok: true, bytes, mime: sniffed, finalUrl: logical.toString() };
  }
  return { ok: false, reason: "tooManyRedirects", retryable: false };
}

/** Retry wrapper: 3 retries with exponential backoff + jitter on retryable failures only. */
export async function fetchImageWithRetry(url: string, o: FetchOpts & { retries?: number; baseDelayMs?: number }): Promise<FetchResult> {
  const retries = o.retries ?? 3;
  let last: FetchResult = { ok: false, reason: "network", retryable: true };
  for (let i = 0; i <= retries; i++) {
    last = await fetchImage(url, o);
    if (last.ok || !last.retryable) return last;
    if (i < retries) await new Promise((r) => setTimeout(r, (o.baseDelayMs ?? 500) * 2 ** i + Math.floor(Math.random() * 100)));
  }
  return last;
}
