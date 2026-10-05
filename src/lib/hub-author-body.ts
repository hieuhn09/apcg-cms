/**
 * Hub author — body checks + guarded conversion (APCGHub P5.1; D19, D23–D25;
 * Public Contracts "Kiểm thân bài").
 *
 * Two tiers, in the frozen order (first failure wins):
 *
 *   PURE, run once BEFORE the tenant check (`validateBodyPure`):
 *     size ≤ 200,000 → NUL / C0 (except \t \n \r) / lone surrogate → trim (W)
 *     → empty ⇒ store empty, no error → W run > 256 → 1b linear pre-check
 *     → `![` → linear dangerous-link scanner.
 *
 *   CONVERSION, run AFTER tenant / feature / references (`convertBody` →
 *   `convertBodyGuarded`): ONE `vm.runInNewContext("fn(a)", …, {timeout})` call
 *   around `convertCore` (hub-author-convert-core.ts). Only
 *   `err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"` maps to `too_slow` (the vm's
 *   timeout error is not an `Error` of this realm, so never test `instanceof`);
 *   any other throw maps to `node`.
 *
 * This file is the ONLY importer of the `vm` module. Its function never yields
 * inside the vm call, and no timer / race wrapper is used around it (a timer
 * cannot interrupt synchronous code). Node runtime only — the routes using it
 * declare no Edge runtime.
 *
 * Re-exports the synchronous helpers of the core file so callers keep one import
 * path. Must NOT import the read-path regex helper or the read-path body
 * converter of `hub-article-markdown.ts` (both run a quadratic regex).
 */

import vm from "node:vm";
import type { Payload } from "payload";
import { isEmptyBody, loadHubEditorConfig } from "@/lib/hub-article-markdown";
import {
  BODY_MAX_INDENT,
  BODY_MAX_LINES,
  BODY_MAX_LINK_OPENERS,
  BODY_MAX_MARK_CHARS,
  BODY_MAX_MARK_RUNS,
  BODY_PARA_MAX_LINK_OPENERS,
  BODY_PARA_MAX_MARK_RUNS,
  HUB_AUTHOR_LIMITS,
  currentConvertTimeoutMs,
} from "@/lib/hub-author-limits";
import {
  convertCore,
  hasDangerousLinkSyntax,
  hasLongWhitespaceRun,
  isWs,
  lexicalConverters,
  roundTripCore,
  type BodyConverters,
  type ConvertResult,
  type HubEditorConfig,
} from "@/lib/hub-author-convert-core";

export {
  checkExportedMarkdown,
  checkLexicalTree,
  convertCore,
  hasDangerousLinkSyntax,
  hasLongWhitespaceRun,
  HUB_BODY_NODE_TYPES,
  isAllowedLinkUrl,
  isWs,
  lexicalTreesEqual,
  roundTripCore,
} from "@/lib/hub-author-convert-core";
export type { BodyConverters, ConvertResult, HubEditorConfig } from "@/lib/hub-author-convert-core";

// ── Character-class checks shared with hub-author-input.ts ──────────────────

/** NUL / C0 other than \t \n \r. */
export function hasForbiddenC0(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) return true;
  }
  return false;
}

/** A UTF-16 surrogate that is not part of a valid pair. */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/** Bidi controls U+202A–U+202E, U+2066–U+2069. */
export function hasBidi(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

/** Any `![` (image syntax, inline or reference). */
export function hasImageSyntax(md: string): boolean {
  return md.includes("![");
}

// ── 1b linear pre-check (D23; "Định nghĩa đơn vị 1b") ───────────────────────

/** The seven counts of the 1b pre-check (same names as the `pre6` oracle in scripts/hub-probe.ts). */
export interface BodyLinearCounts {
  lines: number;
  markChars: number;
  runs: number;
  links: number;
  maxUnitRuns: number;
  maxUnitLinks: number;
  maxIndent: number;
}

/** `s[i]` is a space or tab inside the line. */
function spaceOrTabAt(s: string, i: number, end: number): boolean {
  if (i >= end) return false;
  const c = s.charCodeAt(i);
  return c === 32 || c === 9;
}

/**
 * One pass over the (trimmed) body. Lines: each LF, CR, U+2028, U+2029 is one
 * break (CRLF = 2). Units split ONLY on LF; a blank line is `^[\t ]*$`; a non-blank
 * line opens a new unit only at `^>[ \t]`, `^#{1,6}[ \t]`, `^[ \t]*[-*+][ \t]`,
 * `^[ \t]*[0-9]{1,9}\.[ \t]` (`1)` is NOT a fence). Mark runs (maximal runs of ONE
 * of `*` `_` `` ` `` `~`) and `](` add up over a unit. Indent = leading W of EVERY
 * LF line — counted exactly as the frozen oracle `pre6` counts it (a line made only
 * of W counts too; stricter than "lines with a non-W character", and the oracle
 * parity check compares the numbers directly).
 */
export function countBodyLinear(s: string): BodyLinearCounts {
  const n = s.length;
  let breaks = 0, markChars = 0, runs = 0, links = 0, maxIndent = 0;
  let unitRuns = 0, unitLinks = 0, maxUnitRuns = 0, maxUnitLinks = 0, inUnit = false;
  const flush = () => {
    if (inUnit) {
      if (unitRuns > maxUnitRuns) maxUnitRuns = unitRuns;
      if (unitLinks > maxUnitLinks) maxUnitLinks = unitLinks;
    }
    unitRuns = 0;
    unitLinks = 0;
    inUnit = false;
  };
  let start = 0;
  while (start <= n) {
    let end = s.indexOf("\n", start);
    if (end === -1) end = n;
    else breaks++;
    let p = start;
    while (p < end && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9)) p++;
    let w = start;
    while (w < end && isWs(s.charCodeAt(w))) w++;
    if (w - start > maxIndent) maxIndent = w - start;
    if (p === end) {
      flush();
    } else {
      const c0 = s.charCodeAt(start);
      let fence = false;
      if (c0 === 62 && spaceOrTabAt(s, start + 1, end)) fence = true;
      else if (c0 === 35) {
        let h = start;
        while (h < end && h - start <= 6 && s.charCodeAt(h) === 35) h++;
        if (h - start <= 6 && spaceOrTabAt(s, h, end)) fence = true;
      }
      if (!fence) {
        const c = s.charCodeAt(p);
        if ((c === 45 || c === 42 || c === 43) && spaceOrTabAt(s, p + 1, end)) fence = true;
        else {
          let d = p;
          while (d < end && d - p <= 9 && s.charCodeAt(d) >= 48 && s.charCodeAt(d) <= 57) d++;
          if (d > p && d - p <= 9 && d < end && s.charCodeAt(d) === 46 && spaceOrTabAt(s, d + 1, end)) fence = true;
        }
      }
      if (fence) flush();
      inUnit = true;
      let cur = 0;
      for (let i = start; i < end; i++) {
        const c = s.charCodeAt(i);
        if (c === 13 || c === 0x2028 || c === 0x2029) breaks++;
        if (c === 42 || c === 95 || c === 96 || c === 126) {
          markChars++;
          if (c !== cur) {
            cur = c;
            runs++;
            unitRuns++;
          }
        } else {
          cur = 0;
          if (c === 93 && i + 1 < end && s.charCodeAt(i + 1) === 40) {
            links++;
            unitLinks++;
          }
        }
      }
    }
    if (end === n) break;
    start = end + 1;
  }
  flush();
  return { lines: breaks + 1, markChars, runs, links, maxUnitRuns, maxUnitLinks, maxIndent };
}

/** The 1b gate: any of the seven thresholds exceeded ⇒ not ok (422 `too_large`). */
export function precheckBodyLinear(md: string): { ok: boolean; counts: BodyLinearCounts } {
  const c = countBodyLinear(md);
  const ok =
    c.lines <= BODY_MAX_LINES &&
    c.markChars <= BODY_MAX_MARK_CHARS &&
    c.runs <= BODY_MAX_MARK_RUNS &&
    c.links <= BODY_MAX_LINK_OPENERS &&
    c.maxUnitRuns <= BODY_PARA_MAX_MARK_RUNS &&
    c.maxUnitLinks <= BODY_PARA_MAX_LINK_OPENERS &&
    c.maxIndent <= BODY_MAX_INDENT;
  return { ok, counts: c };
}

export type BodyPureCode = "too_large" | "c0" | "surrogate" | "ws_run" | "image" | "link";

/**
 * The pure body checks, in the frozen order, run EXACTLY ONCE before the tenant
 * check. `body` = the W-trimmed text ("" = empty body, stored empty, no error).
 */
export function validateBodyPure(md: string): { ok: true; body: string } | { ok: false; code: BodyPureCode } {
  if (md.length > HUB_AUTHOR_LIMITS.body) return { ok: false, code: "too_large" };
  if (hasForbiddenC0(md)) return { ok: false, code: "c0" };
  if (hasLoneSurrogate(md)) return { ok: false, code: "surrogate" };
  const body = md.trim();
  if (body === "") return { ok: true, body: "" };
  if (hasLongWhitespaceRun(body)) return { ok: false, code: "ws_run" };
  if (!precheckBodyLinear(body).ok) return { ok: false, code: "too_large" };
  if (hasImageSyntax(body)) return { ok: false, code: "image" };
  if (hasDangerousLinkSyntax(body)) return { ok: false, code: "link" };
  return { ok: true, body };
}

// ── The hard time guard ─────────────────────────────────────────────────────

/** The vm script text: call the injected function with the injected argument. Nothing else. */
export const VM_SCRIPT = "fn(a)";

/**
 * Run `fn(arg)` inside ONE fresh vm context with a hard `timeout`. `fn` must be
 * fully synchronous (hub-author-convert-core.ts). Throws whatever `fn` throws,
 * or the vm timeout error (`code === "ERR_SCRIPT_EXECUTION_TIMEOUT"`).
 */
export function runWithHardTimeout<A, R>(fn: (a: A) => R, arg: A, timeoutMs: number): R {
  return vm.runInNewContext(VM_SCRIPT, { fn, a: arg }, { timeout: timeoutMs }) as R;
}

/** The vm timeout error, recognised by its code ONLY (it is not an `Error` of this realm). */
export function isVmTimeoutError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
}

function errorInfo(err: unknown): { name: string; code?: string } {
  const o = typeof err === "object" && err !== null ? (err as { name?: unknown; code?: unknown }) : {};
  const name = typeof o.name === "string" ? o.name : typeof err;
  return typeof o.code === "string" ? { name, code: o.code } : { name };
}

/**
 * Conversion (4) → (5) → (6) → gate F → re-check of lex2, in ONE vm call.
 * Returns `lexical` = lex2 (the stored tree) or a closed failure reason.
 * `timeoutMs` and `deps` are injectable for unit checks.
 */
export function convertBodyGuarded(
  editorConfig: HubEditorConfig,
  md: string,
  timeoutMs: number = currentConvertTimeoutMs(),
  deps?: Partial<BodyConverters>,
): ConvertResult {
  const real = deps?.toLexical && deps?.toMarkdown ? null : lexicalConverters(editorConfig);
  const conv: BodyConverters = {
    toLexical: deps?.toLexical ?? (real as BodyConverters).toLexical,
    toMarkdown: deps?.toMarkdown ?? (real as BodyConverters).toMarkdown,
  };
  try {
    return runWithHardTimeout(convertCore, { md, toLexical: conv.toLexical, toMarkdown: conv.toMarkdown }, timeoutMs);
  } catch (err) {
    return { ok: false, reason: isVmTimeoutError(err) ? "too_slow" : "node", error: errorInfo(err) };
  }
}

/** Load the cached editor config (outside the vm call) and run the guarded conversion. */
export async function convertBody(
  payload: Payload,
  md: string,
  deps?: Partial<BodyConverters>,
): Promise<ConvertResult> {
  const editorConfig = await loadHubEditorConfig(payload.config);
  return convertBodyGuarded(editorConfig as HubEditorConfig, md, currentConvertTimeoutMs(), deps);
}

/**
 * Is a STORED body safe to replace through Markdown (D6)? Empty body ⇒ safe.
 * Otherwise `roundTripCore` (export → import → compare) inside ONE vm call; a
 * timeout or any throw ⇒ NOT safe (`bodyEditable:false`; PATCH ⇒ `body_not_editable`).
 */
export function isRoundTripSafeBody(
  editorConfig: HubEditorConfig,
  lexical: unknown,
  timeoutMs: number = currentConvertTimeoutMs(),
  deps?: Partial<BodyConverters>,
): boolean {
  if (isEmptyBody(lexical)) return true;
  const real = deps?.toLexical && deps?.toMarkdown ? null : lexicalConverters(editorConfig);
  try {
    return (
      runWithHardTimeout(
        roundTripCore,
        {
          lexical,
          toLexical: deps?.toLexical ?? (real as BodyConverters).toLexical,
          toMarkdown: deps?.toMarkdown ?? (real as BodyConverters).toMarkdown,
        },
        timeoutMs,
      ) === true
    );
  } catch {
    return false;
  }
}
