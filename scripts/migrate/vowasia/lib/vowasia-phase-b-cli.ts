/**
 * Exit-code wrapper of the VowAsia phase-B CLIs (import, rollback,
 * rewrite-links, redirects, verify): 0 success (or the returned code), 2 a
 * deliberate refusal with a fixed message, 1 anything else. Every message goes
 * through the phase-A `redact` (connection URLs and known secrets removed).
 */
import { redact } from "./vowasia-cli";

const REFUSAL = new Set(["CliError", "SnapshotError", "RunError", "LocalDbGuardError", "CentralDbNameError", "OutsideRepoError", "VowasiaTimestampsError", "TaxonomyStop", "AnswerFileError"]);

export function phaseBFailure(name: string, err: unknown, env: Record<string, string | undefined> = process.env): { code: number; line: string } {
  const e = err as Error;
  const msg = redact(typeof e?.message === "string" ? e.message : String(err), env);
  if (e && REFUSAL.has(e.name)) return { code: 2, line: `[${name}] ${msg}` };
  return { code: 1, line: `[${name}] failed: ${msg}` };
}

export async function runPhaseB(name: string, fn: () => Promise<number>, deps: { exit: (c: number) => void; error: (l: string) => void; env: Record<string, string | undefined> } = { exit: (c) => process.exit(c), error: (l) => console.error(l), env: process.env }): Promise<void> {
  try {
    deps.exit(await fn());
  } catch (err) {
    const f = phaseBFailure(name, err, deps.env);
    deps.error(f.line);
    deps.exit(f.code);
  }
}
