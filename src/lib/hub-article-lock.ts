/**
 * Hub article lock (APCGHub P5.2 / CMS-A): run one hub write inside ONE explicit
 * Payload transaction that holds a transaction-level Postgres advisory lock on
 * the article (and, at most once, on a tenant slug). Content-engine plan
 * process/features/apcg-hub/active/apcg-hub-p5-2-publish-schedule-unpublish_PLAN_30-09-26.md,
 * K6 (the fixed contract of `withHubArticleLock`) and §4.3.
 *
 *   withHubArticleLock({ tenantId, articleId? }, fn, ops?) : Promise<Response>
 *
 * - The helper calls `getPayload` itself (through the default `ops`) and ALWAYS
 *   returns a Response; it never throws "busy".
 * - `fn(ctx)` returns `{ ok: true, value }` (success) or `{ ok: false, value }`
 *   (every error branch); `value` is a Response. COMMIT only on `{ ok: true }`
 *   with the transaction still alive; KILL on `{ ok: false }`, on any throw and
 *   on busy.
 * - Busy = Postgres 55P03 (lock_timeout) / 40P01 (deadlock) / 40001
 *   (serialization), read by `pgErrorCode` (err.code, then ONE level of
 *   `cause`), anywhere: taking the article lock, `ctx.lockSlug`, inside `fn`,
 *   at commit ⇒ kill + `busyResponse()` (503 + Retry-After: 2).
 * - Any other error ⇒ kill, then the SAME error is rethrown (the handler's outer
 *   catch turns it into 500 + integration_error, unchanged).
 * - Transaction gone after `{ ok: true }` (a nested Payload error can end it) ⇒
 *   no commit is pretended: kill, then `HubLockTransactionLost` is thrown ⇒ 500.
 * - Two phases, in this order only: the article lock (when `articleId` is given),
 *   then at most ONE slug lock through `ctx.lockSlug` (only inside `fn`; a
 *   second call, or a call after `fn` returned, throws). No other export takes
 *   a lock.
 * - `SET LOCAL lock_timeout = '3s'` and `SET LOCAL
 *   idle_in_transaction_session_timeout = '30s'` right after the transaction
 *   opens (no unbounded wait on the lock or on a row lock; an abandoned
 *   transaction is ended by Postgres).
 *
 * Transaction-level locks only (session-level locks are unsafe behind a
 * transaction-mode pooler). The lock covers hub-with-hub writes only: CMS admin,
 * the engine intake and the CMS crons do not take it.
 *
 * `ops` is an injection seam for unit checks (`scripts/hub-probe.ts --check7
 * --unit-only`): with fake `ops` the helper never touches `getPayload`.
 * Logs carry an error NAME and CODE only.
 */

import { createLocalReq, getPayload, type Payload, type PayloadRequest } from "payload";
import { sql } from "@payloadcms/db-postgres";
import config from "@payload-config";
import { json } from "@/lib/http";

/** Key namespaces (pinned by `--check7 --unit-only` LA-KEY1). */
export const HUB_LOCK_NS_ARTICLE = "apcghub.p52.article";
export const HUB_LOCK_NS_SLUG = "apcghub.p52.slug";
/** `SET LOCAL` values (pinned by LA-KEY5). */
export const HUB_LOCK_TIMEOUT = "3s";
export const HUB_LOCK_IDLE_TIMEOUT = "30s";

/** Postgres codes that mean "retry later": lock_timeout, deadlock, serialization failure. */
const BUSY_CODES: ReadonlySet<string> = new Set(["55P03", "40P01", "40001"]);

/** `err.code`, then ONE level of `err.cause.code` — never deeper (K6). Shared with hub-author-handlers. */
export function pgErrorCode(err: unknown): string | undefined {
  const o = (typeof err === "object" && err !== null ? err : {}) as { code?: unknown; cause?: unknown };
  if (typeof o.code === "string") return o.code;
  const c = (typeof o.cause === "object" && o.cause !== null ? o.cause : {}) as { code?: unknown };
  return typeof c.code === "string" ? c.code : undefined;
}

export function isBusyCode(code: string | undefined): boolean {
  return code !== undefined && BUSY_CODES.has(code);
}

/** The ONE busy Response (503 + Retry-After: 2), shared by the helper and the handlers' `writeFailed`. */
export function busyResponse(): Response {
  return json({ ok: false, status: "busy", reason: "article is being modified, retry" }, 503, { "Retry-After": "2" });
}

/** Thrown when the transaction is gone after `fn` reported success: the write outcome is unknown ⇒ 500. */
export class HubLockTransactionLost extends Error {
  constructor() {
    super("hub lock transaction lost");
    this.name = "HubLockTransactionLost";
  }
}

/** FNV-1a 32-bit over the UTF-8 bytes, as a signed int32. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

type TenantId = number | string;

/** Article key: (hash of the namespace + NUL + tenant id, article id) — the tenant is part of the key. */
export function articleLockKey(tenantId: TenantId, articleId: number): [number, number] {
  return [fnv1a32(`${HUB_LOCK_NS_ARTICLE}\u0000${tenantId}`), articleId | 0];
}

/** Slug key: (hash of the namespace, hash of tenant id + NUL + slug); the slug exactly as stored / compared. */
export function slugLockKey(tenantId: TenantId, slug: string): [number, number] {
  return [fnv1a32(HUB_LOCK_NS_SLUG), fnv1a32(`${tenantId}\u0000${slug}`)];
}

export type HubLockResult = { ok: true; value: Response } | { ok: false; value: Response };

export interface HubLockCtx {
  /** Carries the transaction: pass it to every `payload.*` write / read that must run inside it. */
  req: PayloadRequest | undefined;
  /** Take the slug lock (after the article lock; at most once; only while `fn` runs). */
  lockSlug: (slug: string) => Promise<void>;
}

export interface HubLockTx {
  req: PayloadRequest | undefined;
  /** False once the transaction is gone (e.g. ended by a nested Payload error). */
  alive: () => boolean;
}

/** Injection seam: open the transaction (incl. the SET LOCALs), take a key, commit, kill. */
export interface HubLockOps {
  begin: () => Promise<HubLockTx>;
  acquire: (tx: HubLockTx, k1: number, k2: number) => Promise<void>;
  commit: (tx: HubLockTx) => Promise<void>;
  kill: (tx: HubLockTx) => Promise<void>;
}

interface Executor {
  execute: (q: unknown) => Promise<unknown>;
}
/** The postgres adapter's transaction API (not on Payload's base adapter type). */
interface TxAdapter {
  beginTransaction: () => Promise<number | string | null>;
  commitTransaction: (id: number | string) => Promise<void>;
  rollbackTransaction: (id: number | string) => Promise<void>;
  sessions?: Record<string, { db?: Executor } | undefined>;
}
interface PgTx extends HubLockTx {
  payload: Payload;
  adapter: TxAdapter;
  id: number | string;
  exec: Executor;
}

const SCOPE = "hub/articles/lock";

function errName(err: unknown): string {
  const n = (err as { name?: unknown } | null)?.name;
  return typeof n === "string" ? n : typeof err;
}

function logEnd(payload: Payload, what: "kill", err: unknown): void {
  const code = pgErrorCode(err);
  payload.logger.warn(`[${SCOPE}] ${what} failed: name=${errName(err)}${code ? ` code=${code}` : ""}`);
}

/** The real `ops`: a Payload transaction on the postgres adapter; raw SQL on the transaction's own session. */
function payloadLockOps(): HubLockOps {
  return {
    async begin(): Promise<PgTx> {
      const payload = await getPayload({ config });
      const adapter = payload.db as unknown as TxAdapter;
      const id = await adapter.beginTransaction();
      if (id == null) throw new Error("hub lock: beginTransaction returned no id");
      try {
        const exec = adapter.sessions?.[String(id)]?.db;
        if (!exec) throw new Error("hub lock: no session for the new transaction");
        await exec.execute(sql.raw(`SET LOCAL lock_timeout = '${HUB_LOCK_TIMEOUT}'`));
        await exec.execute(sql.raw(`SET LOCAL idle_in_transaction_session_timeout = '${HUB_LOCK_IDLE_TIMEOUT}'`));
        const req = (await createLocalReq({ context: {} }, payload)) as PayloadRequest;
        req.transactionID = id;
        return {
          req,
          payload,
          adapter,
          id,
          exec,
          alive: () => Boolean(req.transactionID) && Boolean(adapter.sessions?.[String(id)]),
        };
      } catch (err) {
        await adapter.rollbackTransaction(id).catch((e: unknown) => logEnd(payload, "kill", e));
        throw err;
      }
    },
    async acquire(tx, k1, k2) {
      await (tx as PgTx).exec.execute(sql`SELECT pg_advisory_xact_lock(${k1}::int4, ${k2}::int4)`);
    },
    async commit(tx) {
      const t = tx as PgTx;
      await t.adapter.commitTransaction(t.id);
    },
    async kill(tx) {
      // Must survive a transaction that is already gone: log name + code, never throw.
      const t = tx as PgTx;
      try {
        await t.adapter.rollbackTransaction(t.id);
      } catch (err) {
        logEnd(t.payload, "kill", err);
      }
    },
  };
}

async function killQuietly(ops: HubLockOps, tx: HubLockTx): Promise<void> {
  try {
    await ops.kill(tx);
  } catch {
    // A kill on a dead transaction must not mask the outcome; the default ops log it themselves.
  }
}

export async function withHubArticleLock(
  args: { tenantId: TenantId; articleId?: number },
  fn: (ctx: HubLockCtx) => Promise<HubLockResult>,
  ops?: HubLockOps,
): Promise<Response> {
  const o = ops ?? payloadLockOps();
  let tx: HubLockTx | null = null;
  let ended = false;
  try {
    tx = await o.begin();
    const held = tx;
    if (args.articleId != null) await o.acquire(held, ...articleLockKey(args.tenantId, args.articleId));
    let slugTaken = false;
    let open = true;
    let r: HubLockResult;
    try {
      r = await fn({
        req: held.req,
        lockSlug: async (slug: string) => {
          if (!open) throw new Error("hub lock: lockSlug used after the locked block ended");
          if (slugTaken) throw new Error("hub lock: lockSlug called twice");
          slugTaken = true;
          await o.acquire(held, ...slugLockKey(args.tenantId, slug));
        },
      });
    } finally {
      open = false;
    }
    if (!r.ok) {
      ended = true;
      await killQuietly(o, held);
      return r.value;
    }
    if (!held.alive()) {
      ended = true;
      await killQuietly(o, held);
      throw new HubLockTransactionLost();
    }
    await o.commit(held);
    ended = true;
    return r.value;
  } catch (err) {
    if (tx && !ended) await killQuietly(o, tx);
    if (err instanceof HubLockTransactionLost) throw err;
    if (isBusyCode(pgErrorCode(err))) return busyResponse();
    throw err;
  }
}
