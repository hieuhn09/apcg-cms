/**
 * STRICT output guard for VowAsia phase B files that hold legacy content or
 * run state (snapshot, image store, measure report, later the run journal):
 * the directory must be OUTSIDE the repository working tree, and outside ANY
 * git working tree. Unlike `assertOutDirSafe` (./out-dir, kept unchanged for
 * discover), a git-ignored directory inside the repo is REFUSED too, because
 * `git clean -fdx` or a re-clone would silently delete it (Amendment 3,
 * U17/U22).
 *
 * Three independent checks, all run BEFORE anything is created:
 *   1. path strings: the absolute path, and the realpath of its nearest
 *      EXISTING ancestor (+ the not-yet-created tail), against the repo root
 *      and its realpath (`realpathSync.native`, which also canonicalises the
 *      letter case on case-insensitive file systems such as macOS);
 *   2. inodes: the (dev, ino) of every ancestor of the nearest existing
 *      ancestor (both its spelled and its real chain) against the repo root,
 *      so a differently spelled path to the same directory is still caught;
 *   3. git: `git -C <nearest existing ancestor> rev-parse --show-toplevel`
 *      succeeding means some git working tree (another checkout, a sibling
 *      worktree, a dotfiles repo at the home directory) owns the path:
 *      refused. Any git failure other than "not a git repository" (git
 *      missing, dubious ownership, ...) fails CLOSED.
 * Directories it creates are mode 700 (`{ create: false }` checks only).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./out-dir";

export const OUTSIDE_REPO_MESSAGES = {
  inside: "out-dir guard: this directory is inside the repository working tree (git-ignored or not); snapshot, image store, reports and run journals must live OUTSIDE the repo; refusing.",
  insideGit: "out-dir guard: this directory is inside a git working tree (another checkout, a sibling worktree, or for example a dotfiles repo at your home directory, which would also cover ~/vowasia-private); choose a directory outside any git working tree; refusing.",
  gitError: "out-dir guard: could not confirm with git that this directory is outside every git working tree (git missing or it reported an error); refusing.",
} as const;

export class OutsideRepoError extends Error {
  override name = "OutsideRepoError";
}

export interface GitProbeResult {
  status: number | null;
  stderr: string;
  error?: Error;
}

export interface OutsideRepoOptions {
  /** Create the directory (mode 700) after the checks. Default true. */
  create?: boolean;
  /** Realpath implementation (tests simulate a non-canonicalising FS). Default `realpathSync.native`. */
  realpath?: (p: string) => string;
  /** git probe (tests inject failures). Default: `git -C <dir> rev-parse --show-toplevel`. */
  git?: (cwd: string) => GitProbeResult;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
}

function nearestExisting(abs: string): { existing: string; tail: string[] } {
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return { existing: cur, tail };
}

function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let d = p; ; d = path.dirname(d)) {
    out.push(d);
    if (path.dirname(d) === d) return out;
  }
}

function defaultGit(cwd: string): GitProbeResult {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"]) delete env[k];
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", env, timeout: 15_000 });
  return { status: r.status, stderr: String(r.stderr ?? ""), ...(r.error ? { error: r.error } : {}) };
}

/** Throws unless `dir` is outside the repo and any git working tree; creates it mode 700 (unless create:false); returns the absolute path. */
export function assertOutsideRepo(dir: string, root: string = repoRoot(), o: OutsideRepoOptions = {}): string {
  const real = o.realpath ?? ((p: string) => realpathSync.native(p));
  const abs = path.resolve(dir);
  const realRoot = real(root);
  const { existing, tail } = nearestExisting(abs);
  const realExisting = real(existing);
  const realish = path.join(realExisting, ...tail);
  if (isInside(abs, root) || isInside(abs, realRoot) || isInside(realish, realRoot)) throw new OutsideRepoError(OUTSIDE_REPO_MESSAGES.inside);
  const rs = statSync(root);
  for (const d of new Set([...ancestors(existing), ...ancestors(realExisting)])) {
    let s;
    try {
      s = statSync(d);
    } catch {
      continue;
    }
    if (s.dev === rs.dev && s.ino === rs.ino) throw new OutsideRepoError(OUTSIDE_REPO_MESSAGES.inside);
  }
  const g = (o.git ?? defaultGit)(realExisting);
  if (g.status === 0) throw new OutsideRepoError(OUTSIDE_REPO_MESSAGES.insideGit);
  if (g.error || !/not a git repository/i.test(g.stderr)) throw new OutsideRepoError(OUTSIDE_REPO_MESSAGES.gitError);
  if (o.create !== false && !existsSync(abs)) {
    const first = mkdirSync(abs, { recursive: true, mode: 0o700 });
    if (first !== undefined) {
      for (let d = abs; isInside(d, first); d = path.dirname(d)) {
        chmodSync(d, 0o700);
        if (d === first) break;
      }
    }
  }
  return abs;
}
