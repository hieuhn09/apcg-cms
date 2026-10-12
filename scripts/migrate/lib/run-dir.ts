/**
 * Run directory bookkeeping for the GTP import (gtp-launch P4, 6.3, A11-S04,
 * A12-N06/N09/N12, A13-R05, E13, E16): `state.json`, `slug-plan.json`, the
 * fsynced journals `slug-map.ndjson` / `media-map.ndjson` and their compacted
 * `slug-map.json` / `media-map.json`. A journal is never truncated within a
 * run; the LAST line for a key wins on compaction (pass 2 re-records baselines).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { FsyncJournal, writeJsonSafe } from "./out-dir";

export interface SlugMapEntry {
  legacyId: string;
  kind: "article" | "event";
  slug: string;
  articleId: number | string;
  status: string;
  createdVersion: number;
  createdUpdatedAt: string;
  baselineVersion: number;
  baselineUpdatedAt: string;
  legacyCreatedAt: string | null;
  legacyUpdatedAt: string | null;
  oldUrl?: string;
  oldSection?: string;
  oldSub?: string;
  pillar?: string;
  subSection?: string;
  rehomed?: boolean;
  duplicateOf?: string;
  internalLinkRewritable?: boolean;
  /** Old-site URLs found in the body text at import (pass 1 input). */
  textLinks?: string[];
  baselineReconstructed?: boolean;
  adopted?: boolean;
  createdAtRun?: string;
}

export interface MediaMapEntry {
  articleLegacyId: string;
  role: "hero" | "body";
  mediaId?: number | string;
  filename: string;
  sha256?: string;
  origin: "created" | "adopted" | "created-pending" | "pending-absent";
  startedAt?: string;
}

export interface RunState {
  runId: string;
  startedAt: string;
  tenant: string;
  mappingFingerprint: string;
  provisional: string[];
  invocations: { at: string; apply: boolean; argv: string[] }[];
  tagsCreated: { id: number | string; slug: string }[];
}

export const RUN_MESSAGES = {
  exists: "import: the run directory already exists; pass --resume to continue it, or use a new --run-id (rollback keeps run directories for audit).",
  missing: "run: the run directory does not exist.",
  badId: "run: --run-id must match ^[A-Za-z0-9_-]+$.",
} as const;

export class RunDirError extends Error {
  override name = "RunDirError";
}

export function checkRunId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new RunDirError(RUN_MESSAGES.badId);
  return id;
}

export class RunDir {
  constructor(readonly dir: string) {}
  p(name: string): string {
    return path.join(this.dir, name);
  }
  exists(): boolean {
    return existsSync(this.dir);
  }
  hasJournal(): boolean {
    return existsSync(this.p("slug-map.ndjson")) || existsSync(this.p("slug-map.json"));
  }
  readJson<T>(name: string, fallback: T): T {
    const f = this.p(name);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : fallback;
  }
  writeJson(name: string, v: unknown): void {
    writeJsonSafe(this.p(name), v);
  }
  state(): RunState | undefined {
    return this.readJson<RunState | undefined>("state.json", undefined);
  }
  slugJournal(): FsyncJournal {
    return new FsyncJournal(this.p("slug-map.ndjson"));
  }
  mediaJournal(): FsyncJournal {
    return new FsyncJournal(this.p("media-map.ndjson"));
  }
  /** Compacted slug map: journal lines (last per legacyId wins) over slug-map.json. */
  slugMap(): SlugMapEntry[] {
    const by = new Map<string, SlugMapEntry>();
    for (const e of this.readJson<SlugMapEntry[]>("slug-map.json", [])) by.set(e.legacyId, e);
    for (const e of readNdjson<SlugMapEntry>(this.p("slug-map.ndjson"))) by.set(e.legacyId, { ...(by.get(e.legacyId) ?? {}), ...e });
    return [...by.values()];
  }
  compactSlugMap(): SlugMapEntry[] {
    const all = this.slugMap();
    this.writeJson("slug-map.json", all);
    return all;
  }
  /** Compacted media map: last line per (articleLegacyId, role, filename) wins. */
  mediaMap(): MediaMapEntry[] {
    const by = new Map<string, MediaMapEntry>();
    const key = (e: MediaMapEntry) => `${e.articleLegacyId}\u0000${e.role}\u0000${e.filename}`;
    for (const e of this.readJson<MediaMapEntry[]>("media-map.json", [])) by.set(key(e), e);
    for (const e of readNdjson<MediaMapEntry>(this.p("media-map.ndjson"))) by.set(key(e), { ...(by.get(key(e)) ?? {}), ...e });
    return [...by.values()];
  }
  compactMediaMap(): MediaMapEntry[] {
    const all = this.mediaMap();
    this.writeJson("media-map.json", all);
    return all;
  }
  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export function readNdjson<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

/** Every run directory under an out dir (for the cross-run orphan definition, A13-R05). */
export function allRunDirs(outDir: string): RunDir[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => new RunDir(path.join(outDir, d.name)))
    .filter((r) => r.hasJournal() || existsSync(r.p("state.json")));
}

/** Article ids journaled by ANY run directory. */
export function journaledArticleIds(outDir: string): Set<string> {
  const ids = new Set<string>();
  for (const r of allRunDirs(outDir)) for (const e of r.slugMap()) if (e.articleId !== undefined && e.articleId !== null) ids.add(String(e.articleId));
  return ids;
}
