/**
 * Output-directory safety for the VowAsia legacy migration tools (own copy of
 * the GTP helper, kept separate on purpose: no GTP file is imported or edited).
 * apcg-cms is a PUBLIC repository and the run artifacts hold schema reports and
 * query logs of a shared legacy database, so every tool calls
 * `assertOutDirSafe(dir)` before it writes anything:
 *   - a directory INSIDE the repo must be git-ignored (`git check-ignore -q`);
 *   - a directory OUTSIDE the repo is allowed;
 *   - directories it creates are mode 700 (an existing one keeps its mode),
 *     sensitive files are written mode 600.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OUT_DIR_MESSAGES = {
  notIgnored: "out-dir guard: the output directory is inside the repository but NOT git-ignored; refusing to write.",
  noGit: "out-dir guard: cannot run git to check the output directory; refusing to write.",
} as const;

export class OutDirError extends Error {
  override name = "OutDirError";
}

/**
 * Repository root (the directory holding this repo's .git and package.json),
 * resolved from this file: scripts/migrate/vowasia/lib is FOUR levels below it.
 * (The GTP copy lives three levels down; copying its `..` x3 here would make
 * `<repo>/scripts` the "root" and silently skip the git-ignore check for any
 * in-repo directory outside scripts/.)
 */
export function repoRoot(): string {
  return path.resolve(moduleDir(import.meta.url), "..", "..", "..", "..");
}

/** Directory of a module from its `import.meta.url` (decodes %20 and non-ASCII, unlike URL.pathname). */
export function moduleDir(url: string): string {
  return path.dirname(fileURLToPath(url));
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Throws OutDirError unless `dir` is outside the repo or git-ignored inside it. Creates it mode 700. */
export function assertOutDirSafe(dir: string, root: string = repoRoot()): string {
  const abs = path.resolve(dir);
  if (isInside(abs, root)) {
    const probe = path.join(path.relative(root, abs), "probe");
    try {
      execFileSync("git", ["-C", root, "check-ignore", "-q", "--", probe], { stdio: "ignore" });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 1) throw new OutDirError(OUT_DIR_MESSAGES.notIgnored);
      throw new OutDirError(OUT_DIR_MESSAGES.noGit);
    }
  }
  // Only directories created here are forced to 700 (umask may widen mkdir's mode);
  // an existing directory chosen by the owner keeps its own mode.
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

/** Atomic write (tmp + rename), file mode 600. */
export function writeFileSafe(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function writeJsonSafe(file: string, value: unknown): void {
  writeFileSafe(file, JSON.stringify(value, null, 2) + "\n");
}

/** Append-only, fsynced line journal (file descriptor held open for the run). */
export class FsyncJournal {
  private fd: number;
  constructor(readonly file: string) {
    this.fd = openSync(file, "a", 0o600);
    chmodSync(file, 0o600);
  }
  append(obj: unknown): void {
    writeSync(this.fd, JSON.stringify(obj) + "\n");
    fsyncSync(this.fd);
  }
  close(): void {
    closeSync(this.fd);
  }
}
