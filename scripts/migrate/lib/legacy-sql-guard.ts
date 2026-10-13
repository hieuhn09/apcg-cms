/**
 * Thin export of the legacy SQL guard (gtp-launch P4 checklist A3). The real
 * implementation, the closed builders and the read-only driver live in
 * `./legacy-sql.ts`; import from there. This file exists so the guard has the
 * name the plan uses.
 */
export { assertSafeQuery, assertLexicallySafe, LegacySqlError, SQL_MESSAGES, LegacyReadOnlyDb } from "./legacy-sql";
