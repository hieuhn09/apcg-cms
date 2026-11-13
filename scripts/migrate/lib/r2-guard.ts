/**
 * Images of a real (non-local) import must land on R2. payload.config.ts only wires the
 * R2 storage adapter when all four R2 vars are set; without them Payload silently falls
 * back to local disk, so every imported `media` doc would point at a file that exists
 * only on the machine that ran the import, and the article images break in Central.
 * The importer refuses a non-local run (dry run included, so the gap shows before
 * --apply) while any of them is missing or blank.
 */
export const R2_VARS = ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

export function missingR2Vars(env: Readonly<Record<string, string | undefined>>): string[] {
  return R2_VARS.filter((k) => !(env[k] ?? "").trim());
}

export function r2GuardMessage(missing: readonly string[]): string {
  return `import: Central is not local but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set; images would be saved to this machine's disk instead of R2. Set the four R2 vars in .env.local first.`;
}
