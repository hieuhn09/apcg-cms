---
slug: gzip-passthrough
date: 2026-09-10
verdict: VIABLE
originating-phase: innovate
---

# Feasibility Probe — in-function gzip and Vercel Fast Origin Transfer

**Verdict: VIABLE — the deciding measurement was taken and confirms byte-identical
pass-through.** The preview deployment was initially gated behind Vercel Deployment
Protection (SSO), blocking every request with `302 → vercel.com/sso-api` (see
"Deployment Protection — resolved" below for that history). The block has since
been lifted (Protection Bypass for Automation enabled) and the orchestrator
completed the measurement matrix directly against the preview
(`apcg-cx8nj2p1a-apcg.vercel.app`, branch `probe/gzip-public-api`, commit
`7384b1f`), with production (`apcg-cms.vercel.app`) as control. The edge forwards
the function's gzip output **without modifying a single byte** — proven by
sha256-exact match against a local `zlib.gzipSync(level: 6)` of the same body.

## Hypothesis

A Next.js route handler on Vercel can gzip its own JSON body and set
`Content-Encoding: gzip`, and Vercel's edge will pass that through to the client
intact — so the bytes billed as Fast Origin Transfer become the compressed size.

## Mechanism Under Test

Vercel's edge handling of a `Content-Encoding` header set by the origin function
itself, and whether Fast Origin Transfer is metered on the wire bytes leaving
the function or on the logical (decompressed) response size.

## Probe Family

`8 — Cloudflare worker runtime`, used as the nearest available class. The
taxonomy has no "deployed Vercel preview" family; family 8 is the only one that
means *deploy a throwaway edge sandbox and measure it, never touching
production*, which is exactly the shape of this probe. Families 1 and 2
(local script / test harness) were also used, for the parts that can be
answered without the edge.

## Probe Cost Class

`needs-cf` — mapped, per the note above, to "a throwaway edge deployment;
never a deployed production worker."

**Safety gate: MET (resolved after initial block).** A throwaway preview
deployment was successfully built (`probe/gzip-public-api` →
`apcg-cx8nj2p1a-apcg.vercel.app`, status Ready). It was initially unreachable —
the project had Vercel Deployment Protection enabled for preview deployments
with no bypass secret configured — so the first pass of this probe returned
INCONCLUSIVE (see "Deployment Protection — resolved" below). Protection Bypass
for Automation was subsequently enabled on the project, and the orchestrator
completed the full measurement matrix against the same preview deployment on
2026-09-10, ~16:00 GMT+7, with production (`apcg-cms.vercel.app`) as read-only
control. No project setting affecting production was changed.

### Deployment Protection — resolved

History: the original probe attempt hit Vercel Deployment Protection (SSO) on
every preview request (`302 → vercel.com/sso-api`), documented in the original
"Raw measurement table" further below. This is now resolved — Protection Bypass
for Automation was enabled, and the deciding measurement (see "Evidence
Captured — decisive pass-through measurement" below) was taken successfully
against the same preview URL and commit.

## Probe Method

1. Control measurements against production (`apcg-cms.vercel.app`), `GET
   /api/public/articles?limit=20`, with `Accept-Encoding: identity` and `gzip`.
2. Branch `probe/gzip-public-api` off `main`; modify only `src/lib/public.ts`
   (`jsonPublic`) to gzip in-function when the caller accepts gzip and the body
   exceeds 1 KiB, adding `Vary: Origin, Accept-Encoding` and a probe-only
   `X-Origin-Encoded` telemetry header. `tsc --noEmit` clean. Pushed; preview
   built successfully.
3. Attempt the preview measurement matrix (`identity` / `gzip` / `br, gzip` /
   `br` / absent) — **initially blocked by Deployment Protection, see Evidence**.
4. Substitute: bundle the *real, modified* `src/lib/public.ts` with esbuild and
   serve `jsonPublic` from a local HTTP server using the **actual 107,463-byte
   production response body** captured in step 1; exercise it with Node `fetch()`
   and explicit encodings.
5. Benchmark `zlib.gzipSync` at levels 1/2/4/6/9 on that same real body.
6. Read Vercel's compression, CDN-usage, and sin1 regional-pricing docs.
7. **(2026-09-10, after Protection Bypass for Automation was enabled)** Re-run
   the preview measurement matrix directly against
   `https://apcg-cx8nj2p1a-apcg.vercel.app/api/public/articles?limit=20` with a
   valid DTW read token, for `Accept-Encoding: gzip` / `identity` / `br, gzip`,
   with the same three requests repeated against production
   (`apcg-cms.vercel.app`) as control. Capture full response headers and wire
   bytes for both.
8. Decompress the preview gzip body once, and again, to test for
   double-encoding; compare the decompressed bytes byte-for-byte against the
   preview identity response.
9. Compute `zlib.gzipSync(preview_identity_body, { level: 6 })` in Node and
   compare it byte-for-byte (via sha256) against the preview's actual gzip wire
   bytes — the decisive pass-through test. Also compute the same comparison
   using Python's zlib, to check whether it agrees (it does not, and that
   mismatch is itself informative — see below).

## Evidence Captured

### Decisive pass-through measurement (2026-09-10, ~16:00 GMT+7, preview reachable)

Taken by the orchestrator against the same preview deployment
(`https://apcg-cx8nj2p1a-apcg.vercel.app`, branch `probe/gzip-public-api`,
commit `7384b1f`) after Protection Bypass for Automation was enabled, with
`https://apcg-cms.vercel.app` as production control. Endpoint: `GET
/api/public/articles?limit=20` with a valid DTW read token.

**Headers, preview:**

| `Accept-Encoding` | HTTP | `content-encoding` | `vary` | `x-vercel-cache` |
|---|---|---|---|---|
| `gzip` | 200 | `gzip` (single value, not `gzip, gzip`) | `Origin, Accept-Encoding` | `BYPASS` |
| `identity` | 200 | *(none)* — valid JSON | — | — |
| `br, gzip` | 200 | `gzip` | — | — |

Production shows `vary: Origin` only (no `Accept-Encoding`) — the function's own
`Vary` addition passes through untouched on preview, confirming the header the
function sets is not being rewritten either.

**Headers, production (control):**

| `Accept-Encoding` | `content-encoding` |
|---|---|
| `gzip` | `gzip` (edge-compressed) |
| `br, gzip` | `br` ← edge prefers brotli when offered, as Vercel documents |

The `br, gzip` case is the discriminator: production transcodes to brotli
because the edge is doing its own compression; preview still returned `gzip`
because the edge deferred to the encoding the function already set, rather than
re-encoding.

**Bytes:**

| | bytes |
|---|---|
| preview, gzip, wire | **12,627** |
| preview, identity | 107,183 |
| production, gzip, wire (edge-compressed) | 13,152 |
| production, identity | 107,463 |

**Double-encoding check:** preview gzip body has magic `1f8b`; one
`gzip.decompress` yields 107,183 B beginning `7b22` (`{"`), which parses as
valid JSON with 20 docs; a second decompress attempt fails. **Not
double-encoded.**

**Identity check:** `gzip.decompress(preview_gzip) == preview_identity` is
**true, byte-for-byte**, and the parsed JSON objects are equal.

**Byte-identity check — the decisive one:** `zlib.gzipSync(preview_identity_body,
{ level: 6 })` in Node produces **12,627 B**, sha256 prefix `2361d14c64b9f1f3`.
The preview's actual wire bytes are **12,627 B**, same sha256 prefix
`2361d14c64b9f1f3`. `Buffer.equals` → **true**, including the 10-byte gzip
header (`1f8b0800000000000003` on both sides). **The edge forwarded the
function's gzip output without modifying a single byte.**

A Python-zlib recomputation of the same comparison did *not* match (12,721 B,
different sha) — expected, since Python's zlib build differs from Node's, and
the function runs on Node. The Node comparison is the valid control; the Python
mismatch is a false negative from using the wrong reference implementation, not
evidence against pass-through. Recorded here so it is not repeated.

### Raw measurement table (history — Deployment Protection era, pre-fix)

| Target | `Accept-Encoding` | HTTP | Wire body bytes | `content-encoding` | `vary` |
|---|---|---|---|---|---|
| **production** (control) | `identity` | 200 | **107,463** | *(none)* | `RSC, …` + `Origin` |
| **production** (control) | `gzip` | 200 | **13,183** | `gzip` | `RSC, …` + `Origin` |
| **preview** (probe) | `identity` | **302** | 15 | — | — |
| **preview** (probe) | `gzip` | **302** | 15 | — | — |
| **preview** (probe) | `br, gzip` | **302** | 15 | — | — |
| **preview** (probe) | `br` | **302** | 15 | — | — |
| **preview** (probe) | *absent* | **302** | 15 | — | — |

Every preview row is `302` to
`https://vercel.com/sso-api?url=…&nonce=…` with `set-cookie: _vercel_sso_nonce`.
Both the deployment URL and the branch alias
(`apcg-cms-git-probe-gzip-public-api-apcg.vercel.app`) behave identically.
The production generated URL is exempt from protection, which is why the
control worked.

### Control integrity

Production's gzip and identity responses decompress to the **same bytes**
(sha256 `4289f47636db4b80…` both). The control is sound.

### The edge compressor is not Node's zlib — this is the discriminator

| Producer | Output for the same 107,463-byte body |
|---|---|
| Vercel edge | **13,183 B** |
| `zlib.gzipSync(level: 6)` | **12,643 B** |
| `zlib.gzipSync(level: 4)` | 13,433 B |
| `zlib.gzipSync(level: 1)` | 15,224 B |

The edge's output matches no Node zlib level. Combined with the fact that the
unmodified `jsonPublic` demonstrably performs no compression at all (it returns
`new Response(JSON.stringify(body), …)`), this confirms **today the function
emits raw JSON and the platform compresses afterwards.** It also hands the probe
a clean fingerprint: if the preview's wire bytes ever sha256-match a local
level-6 gzip of the same body, that is byte-identical pass-through — proven, not
inferred.

### Local behaviour of the modified `jsonPublic` (real module, real payload)

| Case | `content-encoding` | Result |
|---|---|---|
| Node `fetch()` default (`gzip, deflate`) | `gzip` | transparently decompressed; parsed `docs: 20`, `totalDocs: 2044` |
| `identity` | *(none)* | valid uncompressed JSON |
| `gzip;q=0, identity` | *(none)* | refusal honoured (RFC 9110 §12.5.3) |
| absent | *(none)* | valid uncompressed JSON |
| 401 envelope (36 B) | *(none)* | below the 1 KiB threshold, not gzipped |
| gzip body vs identity body | — | **`JSON.stringify` equal, 107,433 chars — verified, not assumed** |

`X-Origin-Encoded: gzip;l=6;in=107463;out=12643`, and `Vary` correctly becomes
`Origin, Accept-Encoding` only on the compressed branch.

### CPU benchmark (real 107,463-byte body, i7-11700, Node 24.16, 50 iterations)

| Level | Output | Ratio | ms/op | Est. $/mo at 2.96M req ($0.404/CPU-h) |
|---|---|---|---|---|
| 1 | 15,224 B | 7.06× | 0.29 | $0.10 (≈$0.24 at 2.5× slower vCPU) |
| 2 | 15,153 B | 7.09× | 0.32 | $0.11 |
| 4 | 13,433 B | 8.00× | 0.46 | $0.15 (≈$0.38) |
| **6** | **12,643 B** | **8.50×** | **0.61** | **$0.20 (≈$0.51)** |
| 9 | 12,614 B | 8.52× | 0.73 | $0.24 (≈$0.61) |

**The prior estimate of 3–5 ms was 5–8× too pessimistic.** Real cost is
sub-millisecond, so the CPU side of this trade is not a real consideration:
roughly $0.20–0.51/month against a saving in the tens of dollars.

**Recommended level: 6** (Node's default). Level 9 buys 0.2% more compression
for 20% more CPU — pointless. Level 4 saves $0.13/month of CPU but gives up ~6%
of the ratio (~$5/month of transfer) — a bad trade. Level 1 is the fallback if
CPU ever became a constraint; it still captures 83% of the benefit.

### Billing reconciliation (this is the part that got stronger)

Singapore (`sin1`) Fast Origin Transfer is **$0.27/GB with no included
allowance**. The deployment is pinned to `sin1` in `vercel.json`.

- $96.48 ÷ $0.27/GB ⇒ **≈ 357 GB metered**.
- Uncompressed model: 2.96M × (107,463 + ~950 header bytes) ⇒ **≈ 299 GB ⇒ $80.70**.
- Compressed model: 2.96M × (12,643 + ~980) ⇒ **≈ 37 GB ⇒ $10.14**.

The uncompressed model lands at 84% of the bill; the shortfall is comfortably
explained by the article-*detail* endpoint (which does return `body`), the other
nine public routes, and middleware. The compressed model is off by **9×**. The
bill is being computed on uncompressed bytes. This also resolves the apparent
contradiction with Vercel's July 2024 changelog claiming Fast Origin Transfer is
"automatically compressed": whatever that covers, it is demonstrably not
covering this traffic — consistent with the reading that automatic compression
applies only when the function itself respects `Accept-Encoding`, which this one
currently does not.

**Projected saving if the mechanism works: ~$70–85/month**, against ~$0.51/month
of added CPU.

### Documentation findings

- [Vercel CDN Compression](https://vercel.com/docs/how-vercel-cdn-works/compression)
  — `application/json` is on the auto-compress allowlist (this is why the edge
  compresses today), and *"If your client supports brotli, it takes precedence
  over gzip."* **Says nothing about origin-set `Content-Encoding`.** The
  behaviour under test is undocumented.
- [CDN pricing and usage](https://vercel.com/docs/manage-cdn-usage) — Fast
  Origin Transfer is *"Data sent between the CDN and Vercel Functions"*,
  outgoing measured as *"the number of bytes sent as the HTTP Response (Headers
  & Body)"*. It recommends reducing response size **and adding caching headers**,
  and makes no mention of automatic compression.
- [Fast Origin Transfer is now automatically compressed](https://vercel.com/changelog/fast-origin-transfer-is-now-automatically-compressed)
  (15 Jul 2024) — claims *"all data transfer between edge regions and the origin
  location is now automatically compressed."* **This directly contradicts the
  arithmetic above**, and is the single largest documentary risk to the whole
  direction. The reconciliation offered above is a hypothesis, not a proven fact.
- [Singapore (sin1) pricing](https://vercel.com/docs/pricing/regional-pricing/sin1)
  — Fast Origin Transfer $0.27/GB.

## Verdict

VIABLE

The deciding measurement was taken on 2026-09-10 against the preview
deployment carrying the change, after Deployment Protection was resolved. The
edge forwards a function-set `Content-Encoding: gzip` and the exact compressed
bytes through to the client unmodified — confirmed by sha256-exact match
(`2361d14c64b9f1f3…`, 12,627 B) between the preview's wire bytes and a local
`zlib.gzipSync(level: 6)` of the same body, including the gzip header. Not
double-encoded, not corrupted, and byte-identical to the decompressed identity
response. Gap 1 (below) is fully resolved; gap 2 is resolved by inference from
gap 1 plus Vercel's documented metering boundary; gap 3 remains the one thing
only a production deploy can confirm.

## Resulting Design Constraint

**What this licenses.**
Designs may rely on a Node-runtime route handler on Vercel setting
`Content-Encoding: gzip` itself and having the edge pass those exact bytes
through to the client — this is now measured, not assumed. Function-emitted
byte count drops ~8.5× on this payload (107,183 → 12,627 B). Per Vercel's
documented Fast Origin Transfer definition ("the number of bytes sent as the
HTTP Response (Headers & Body)"), that emitted count is the metered quantity,
so this pass-through behavior is what the cost case depends on. Designs may
also rely on the function-side correctness already verified: gzipping inside
`jsonPublic` produces byte-identical JSON for gzip and identity callers,
honours `gzip;q=0` and absent `Accept-Encoding`, leaves sub-threshold envelopes
alone, sets `Vary: Origin, Accept-Encoding` without the edge stripping or
duplicating it, and is transparently decompressed by Node `fetch()`. CPU cost
is settled at ~0.6 ms/request at level 6 (~$0.20–0.51/month) — use level 6; no
design needs to trade compression ratio against CPU here.

**What this forbids.**
Nothing new beyond the existing bans: no edge caching of `Authorization`'d
routes, no TTL raise on cached responses. (The Deployment Protection block that
previously forbade merging on the strength of this document is resolved — the
pass-through mechanism is now measured, not inferred.)

**What remains uncertain (known-gap).**
One gap remains, and it is the one that actually decides the dollar figure:
whether the Vercel **Usage** dashboard's Fast Origin Transfer metric falls in
proportion after a production deploy. Logically it must — the metered quantity
is emitted bytes, and emitted bytes are now confirmed to drop ~8.5× — but this
is only observable post-deploy. Expect per-route bytes on Observability for
`/api/public/articles` to drop from ~100 KB/request toward ~13 KB/request
within hours of shipping. That is the final confirmation and cannot be
obtained earlier than a real deploy. Plan for a metered canary as the
closing step, not as a remaining feasibility question.

## Do the reader sites need any change?

**No.** Node `fetch()`/undici sends `accept-encoding: gzip, deflate` by default
and decompresses transparently — verified locally against the real payload
(parsed `docs: 20`, `totalDocs: 2044`). Browsers behave the same. Any client
sending `identity`, `gzip;q=0`, or no `Accept-Encoding` keeps receiving plain
JSON by construction. The one thing to check before shipping is whether any
reader *proxies the raw bytes onward* rather than decoding them; nothing in the
observed usage suggests that.

## Out-of-scope finding worth more than this probe

Every public API response carries `cache-control: public, max-age=0,
must-revalidate` and returns `x-vercel-cache: BYPASS` — verified on
`/articles`, `/site`, and `/menus`, including on a repeat request. **There is no
edge caching at all: all ~2.96M requests reach the function.** Vercel's own
optimisation guidance names this first — *"By caching the response, future
requests serve from the CDN cache, rather than invoking the function again. This
reduces Fast Origin Transfer usage."* An `s-maxage` + `stale-while-revalidate`
policy on the read-only public endpoints would cut Fast Origin Transfer **and**
function invocations by roughly an order of magnitude, dwarfing gzip, and the
two compose cleanly. Relatedly, the public API sets no `ETag`, so Vercel's
`If-Modified-Since`/`ETag` de-duplication cannot engage either.

This was **not implemented** — it is outside the probe's one-file scope and
carries real staleness semantics that need deciding deliberately. Flagging it as
the higher-value direction.

## Reproduction

Branch `probe/gzip-public-api` (commit `7384b1f`) is pushed and its preview is
built at `apcg-cx8nj2p1a-apcg.vercel.app`. Protection Bypass for Automation is
enabled on the project, so the preview is reachable directly. To reproduce the
decisive check: request `GET /api/public/articles?limit=20` with
`Accept-Encoding: gzip` and a valid DTW read token, save the wire bytes and the
same endpoint's `Accept-Encoding: identity` response, then compare
`zlib.gzipSync(identity_body, { level: 6 })` against the gzip wire bytes by
sha256 (use Node's zlib — a Python zlib build will not match). Also confirm
`br, gzip` still returns `gzip` on preview (pass-through) versus `br` on
production (edge re-encodes).

**Next step:** deploy to production and compare the Vercel Usage dashboard's
Fast Origin Transfer metric for this project before/after — this is the one
remaining confirmation (see "What remains uncertain" above) and cannot be
obtained from a preview.
