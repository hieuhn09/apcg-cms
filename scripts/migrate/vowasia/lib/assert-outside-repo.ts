/**
 * STRICT output guard for VowAsia phase B files that hold legacy content or
 * run state (snapshot, image store, measure report, later the run journal):
 * the directory must be OUTSIDE the repository working tree. Unlike
 * `assertOutDirSafe` (./out-dir, kept unchanged for discover), a git-ignored
 * directory inside the repo is REFUSED too, because `git clean -fdx` or a
 * re-clone would silently delete it (Amendment 3, U17/U22).
 *
 * Symlinks are resolved: the realpath of the nearest EXISTING ancestor (plus
 * the not-yet-created rest) is compared with the realpath of the repo root, so
 * a link outside the repo that points into it is refused. The check runs
 * BEFORE anything is created; directories it creates are mode 700.
 */
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./out-dir";

export const OUTSIDE_REPO_MESSAGES = {
  inside: "out-dir guard: this directory is inside the repository working tree (git-ignored or not); snapshot, image store, reports and run journals must live OUTSIDE the repo; refusing.",
} as const;

export class OutsideRepoError extends Error {
  override name = "OutsideRepoError";
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Real path of `abs`: realpath of the nearest existing ancestor + the missing tail. */
function realish(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpathSync(cur), ...tail);
}

/** Throws unless `dir` is outside the repo (symlinks resolved); creates it mode 700; returns the absolute path. */
export function assertOutsideRepo(dir: string, root: string = repoRoot()): string {
  const abs = path.resolve(dir);
  const realRoot = realpathSync(root);
  if (isInside(abs, root) || isInside(abs, realRoot) || isInside(realish(abs), realRoot)) throw new OutsideRepoError(OUTSIDE_REPO_MESSAGES.inside);
  if (!existsSync(abs)) {
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
