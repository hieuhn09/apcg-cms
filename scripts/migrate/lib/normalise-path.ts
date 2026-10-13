/**
 * Old-URL path key (gtp-launch P4, A12-N04 as corrected by A13-R03). Used by
 * the redirect builder and parity check 8; gtp-web carries the same function
 * (Phase 3 section 9), pinned to the same golden table (`golden-normalise.json`,
 * sha256 e5b2247c46445568021bdc50050f19ea2ac832e4dc5997b596c374a2ed809a5e).
 *
 * One ROUND: (a0) cut at the first `?` or `#`; (a) percent-decode each segment
 * (unchanged when decoding throws); (b) collapse repeated `/`; (c) lowercase;
 * (d) strip a trailing `/` (not root); (e) strip a trailing `/index.html` or
 * `/index.php`; (f) strip a trailing `.html` or `.php`; (g) strip a trailing
 * `/amp`; (h) strip a trailing `/` again (not root); empty = `/`.
 * Rounds repeat until the output equals the input. More than 8 changing rounds
 * = `normaliseUnconverged` (a counted production flag, never a key). The query
 * and fragment are never part of the key; by design an encoded `?`/`#` ends it.
 */
export type NormaliseResult = { ok: true; key: string } | { ok: false; flag: "normaliseUnconverged" };

export const MAX_CHANGING_ROUNDS = 8;

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

export function normaliseRound(input: string): string {
  let p = input;
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  p = p
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
  p = p.replace(/\/{2,}/g, "/");
  p = p.toLowerCase();
  p = stripTrailingSlash(p);
  p = p.replace(/\/index\.(html|php)$/, "");
  p = p.replace(/\.(html|php)$/, "");
  p = p.replace(/\/amp$/, "");
  p = stripTrailingSlash(p);
  if (p === "") p = "/";
  return p;
}

export function normalise(input: string): NormaliseResult {
  let cur = input;
  for (let changing = 0; ; ) {
    const next = normaliseRound(cur);
    if (next === cur) return { ok: true, key: cur };
    changing++;
    if (changing > MAX_CHANGING_ROUNDS) return { ok: false, flag: "normaliseUnconverged" };
    cur = next;
  }
}

/** Convenience: the key, or null when unconverged. */
export function normaliseKey(input: string): string | null {
  const r = normalise(input);
  return r.ok ? r.key : null;
}
