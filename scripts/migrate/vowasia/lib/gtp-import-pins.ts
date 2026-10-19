/**
 * sha256 pins of every GTP file the VowAsia phase B tooling imports READ-ONLY
 * (Amendment 3, D-B1 / U5 / E-B6). Pinned in chặng B-α for the whole of
 * phase B so chặng B-β never edits this file. A pinned file that changes by
 * one byte turns `test:migrate-vowasia` red: the change must then be reviewed
 * for its effect on VowAsia (behaviour tests in gtp-import-pins.test.ts cover
 * the security functions of media-fetch) and the pin updated deliberately.
 *
 * Paths are relative to the repo root. `gtp-mapping.ts` (type import of
 * gtp-transform) and `legacy-sql.ts` (runtime import of gtp-mapping) and the
 * GTP `out-dir.ts` (import of run-dir) are pinned because they are loaded
 * transitively.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const GTP_IMPORT_PINS: Readonly<Record<string, string>> = Object.freeze({
  "scripts/migrate/lib/media-fetch.ts": "8e0c81eb7dc6b0c73bc1cf609956e6ba27a760d33f309f3b2a24b63b33781145",
  "scripts/migrate/lib/lexical-body.ts": "ba04f2f2d045c6878184c2698288c20eb6d07fdd8a10245b7f722c3b6b38f394",
  "scripts/migrate/lib/gtp-transform.ts": "135c9b6937333925f3513cb96b6819a7f5a255e84e2ec9d82575324e7f218a61",
  "scripts/migrate/lib/gtp-mapping.ts": "58ade9e11500a92238334643ba8ef3125c52ee739350611b3709796e8edf961b",
  "scripts/migrate/lib/legacy-sql.ts": "0fc2925c527d6e06a6ea6d3582a8e4672558a9a8e7be5a91437f7d615ce248b6",
  "scripts/migrate/lib/run-dir.ts": "c0866921426f630eaaee05f202c067bfbf8470ff342e6bcf30ae6295a64709fc",
  "scripts/migrate/lib/out-dir.ts": "9a9033715d2baa024efd4174a9af7aa1494ac1831dc4000bb2f066be386a305a",
  "scripts/migrate/lib/failure-controls.ts": "d1ea89947a4141893773f8e88fdcb90edfd517a45a720150d7bb5287db524f70",
  "scripts/migrate/lib/rollback-rules.ts": "d5779ddaf461f3bb158d2049f8122567b0d073798541d5dbda89542eeb85f7e4",
  "scripts/migrate/lib/load-guard.ts": "279dbddd3f33c9166ba0e772d1611e3835bfcb06d53bbd6300ed54f207f4481a",
  "scripts/migrate/lib/normalise-path.ts": "a72debb25d1c05ed623476d41ddb6ac4d9ef4deb66341a7544255fd28d2e674a",
});

/** Pinned files (relative paths) whose content under `root` is missing or differs from its pin. */
export function pinMismatches(root: string): string[] {
  const bad: string[] = [];
  for (const [rel, want] of Object.entries(GTP_IMPORT_PINS)) {
    const file = path.join(root, rel);
    if (!existsSync(file) || createHash("sha256").update(readFileSync(file)).digest("hex") !== want) bad.push(rel);
  }
  return bad;
}
