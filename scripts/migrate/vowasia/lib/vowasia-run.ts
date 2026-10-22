/**
 * Run directories, journals and the apply lock of the VowAsia phase-B tools
 * (Amendment 3 §3.4 step 6-7, Amendment 4 §4.3/§4.4 item 6; a vowasia COPY of
 * the GTP run-dir idea, no GTP run-dir import).
 *
 * `<runs-dir>` lives OUTSIDE the repo (`assertOutsideRepo`). One sub-directory
 * per `--apply` run id (never reused, no `--resume`); dry-runs write only to
 * `<runs-dir>/dry-<timestamp>`. Journals are append-only, one fsync per line:
 *   intent.ndjson    {legacyId, slug, runId, at}          BEFORE each create
 *   outcome.ndjson   {legacyId, slug, result, ...}        AFTER each attempt
 *                    result: created (id) | failed (reason) | resolved (rollback)
 *   slug-map.ndjson  one line per created article (+ re-baseline lines of rewrite-links)
 *   media.ndjson     {legacyId, role, filename, origin: pending|created|reused, mediaId?}
 *
 * The lock `<runs-dir>/.import.lock` is taken ONLY by `--apply` modes (import,
 * rollback, rewrite-links), created with O_EXCL, holds pid + run id + mode +
 * start time, and is removed on normal exit and on handled errors. A crash
 * leaves it; recovery is manual (VOWASIA-LEGACY.md part B). No override flag.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync, chmodSync } from "node:fs";
import path from "node:path";
import { FsyncJournal, writeJsonSafe } from "./out-dir";

export const LOCK_NAME = ".import.lock";

export const RUN_MESSAGES = {
  badId: "run: --run-id must match ^[A-Za-z0-9_-]{1,80}$ and must not start with dry-; refusing.",
  exists: "run: this run directory already exists; every --apply needs a NEW --run-id (there is no --resume); refusing.",
  missing: "run: no run directory for this --run-id in --runs-dir; refusing.",
  locked: (holder: string) => `lock: ${LOCK_NAME} exists in --runs-dir (held by ${holder}); another --apply is running or a crashed one left it. If no import/rollback/rewrite-links process is running, follow the stale-lock steps in VOWASIA-LEGACY.md part B; refusing.`,
} as const;

export class RunError extends Error {
  override name = "RunError";
}

export function checkRunId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || id.startsWith("dry-")) throw new RunError(RUN_MESSAGES.badId);
  return id;
}

export interface RunState {
  runId: string;
  startedAt: string;
  tenant: string;
  snapshotSha256: string;
  manifestSha256: string;
  limit: number | null;
}

export interface IntentLine {
  legacyId: string;
  slug: string;
  runId: string;
  at: string;
}
export interface OutcomeLine {
  legacyId: string;
  slug: string;
  result: "created" | "failed" | "resolved";
  id?: number | string;
  reason?: string;
  deleted?: boolean;
  at: string;
}
export interface SlugMapLine {
  legacyId: string;
  slug: string;
  articleId: number | string;
  status: string;
  oldStatus: string;
  pillar: string;
  subSection: string | null;
  draftReasons: string[];
  legacyCreatedAt: string | null;
  legacyUpdatedAt: string | null;
  baselineVersion: number;
  baselineUpdatedAt: string;
  createdAtRun: string;
  rewrittenAtRun?: string;
}
export interface MediaLine {
  legacyId: string;
  role: "cover" | "body";
  filename: string;
  origin: "pending" | "created" | "reused";
  mediaId?: number | string;
  at: string;
}

export function readNdjson<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export class RunDir {
  constructor(readonly dir: string) {}
  p(name: string): string {
    return path.join(this.dir, name);
  }
  exists(): boolean {
    return existsSync(this.dir);
  }
  get id(): string {
    return path.basename(this.dir);
  }
  state(): RunState | undefined {
    const f = this.p("state.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as RunState) : undefined;
  }
  intents(): IntentLine[] {
    return readNdjson<IntentLine>(this.p("intent.ndjson"));
  }
  outcomes(): OutcomeLine[] {
    return readNdjson<OutcomeLine>(this.p("outcome.ndjson"));
  }
  media(): MediaLine[] {
    return readNdjson<MediaLine>(this.p("media.ndjson"));
  }
  /** Slug map: the last line per legacy id wins (merged), so rewrite-links re-baselines replace the create baseline. */
  slugMap(): SlugMapLine[] {
    const by = new Map<string, SlugMapLine>();
    for (const e of readNdjson<SlugMapLine>(this.p("slug-map.ndjson"))) by.set(e.legacyId, { ...(by.get(e.legacyId) ?? {}), ...e } as SlugMapLine);
    return [...by.values()];
  }
  /** Intents with NO outcome line at all (created, failed or resolved). */
  dangling(): IntentLine[] {
    const done = new Set(this.outcomes().map((o) => `${o.legacyId}\u0000${o.slug}`));
    return this.intents().filter((i) => !done.has(`${i.legacyId}\u0000${i.slug}`));
  }
  /** Every article id this run references (slug map + outcome lines). */
  articleIds(): Set<string> {
    const ids = new Set<string>();
    for (const e of this.slugMap()) ids.add(String(e.articleId));
    for (const o of this.outcomes()) if (o.id !== undefined && o.id !== null) ids.add(String(o.id));
    return ids;
  }
}

/** Every NAMED run directory (dry-* excluded) under the runs dir. */
export function allRuns(runsDir: string): RunDir[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("dry-"))
    .map((d) => new RunDir(path.join(runsDir, d.name)))
    .filter((r) => existsSync(r.p("state.json")) || existsSync(r.p("intent.ndjson")));
}

/** Create a NEW named run directory (mode 700); refuse an existing one. */
export function createRunDir(runsDir: string, runId: string): RunDir {
  const r = new RunDir(path.join(runsDir, checkRunId(runId)));
  if (r.exists()) throw new RunError(RUN_MESSAGES.exists);
  mkdirSync(r.dir, { mode: 0o700 });
  chmodSync(r.dir, 0o700);
  return r;
}

export class Journals {
  private readonly js = new Map<string, FsyncJournal>();
  constructor(readonly run: RunDir) {}
  private j(name: string): FsyncJournal {
    let x = this.js.get(name);
    if (!x) {
      x = new FsyncJournal(this.run.p(name));
      this.js.set(name, x);
    }
    return x;
  }
  intent(l: IntentLine): void {
    this.j("intent.ndjson").append(l);
  }
  outcome(l: OutcomeLine): void {
    this.j("outcome.ndjson").append(l);
  }
  slug(l: Partial<SlugMapLine> & { legacyId: string }): void {
    this.j("slug-map.ndjson").append(l);
  }
  media(l: MediaLine): void {
    this.j("media.ndjson").append(l);
  }
  close(): void {
    for (const x of this.js.values()) x.close();
    this.js.clear();
  }
}

export function writeState(run: RunDir, s: RunState): void {
  writeJsonSafe(run.p("state.json"), s);
}

/* ── lock (CF4) ─────────────────────────────────────────────────────────── */

export interface LockInfo {
  pid: number;
  runId: string;
  mode: "import" | "rollback" | "rewrite-links";
  startedAt: string;
}

export function readLock(runsDir: string): LockInfo | undefined {
  const f = path.join(runsDir, LOCK_NAME);
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as LockInfo;
  } catch {
    return { pid: -1, runId: "(unreadable)", mode: "import", startedAt: "" };
  }
}

/** Take the lock (O_EXCL). Returns a release function that removes it (idempotent). */
export function acquireLock(runsDir: string, info: LockInfo): () => void {
  const f = path.join(runsDir, LOCK_NAME);
  let fd: number;
  try {
    fd = openSync(f, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const h = readLock(runsDir);
      throw new RunError(RUN_MESSAGES.locked(h ? `pid ${h.pid}, run ${h.runId}, ${h.mode}, since ${h.startedAt}` : "unknown"));
    }
    throw err;
  }
  writeSync(fd, JSON.stringify(info) + "\n");
  closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const h = readLock(runsDir);
      if (h && h.pid === info.pid && h.runId === info.runId && h.mode === info.mode) unlinkSync(f);
    } catch {
      /* already gone */
    }
  };
}
