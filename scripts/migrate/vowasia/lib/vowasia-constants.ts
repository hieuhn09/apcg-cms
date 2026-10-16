/**
 * Fixed identity of the VowAsia legacy migration (phase A tooling; phase B
 * importer will reuse these). Kept apart from every GTP constant on purpose:
 * the VowAsia import marker must never match a GTP-imported article, so a
 * VowAsia rollback/verify can never select GTP rows (and the reverse).
 */
import { CENTRAL_DB_NAME, CENTRAL_DB_PATHNAME } from "../../../lib/central-db-name-guard";

/** Central tenant slug the import targets. */
export const TENANT_SLUG = "vowasia";
/** `engineSourceName` stamped on every imported article. */
export const MARKER_SOURCE_NAME = "legacy:vowasia";
/** `origin` stamped on every imported article. */
export const MARKER_ORIGIN = "import";
/** Slug the legacy `sites` row must carry; any other site is refused. */
export const LEGACY_SITE_SLUG = "vowasia";
/** The only legacy role the tools accept (created by sql/02, removed by sql/03). */
export const LEGACY_ROLE = "vowasia_migrator";
/** Central database name (re-exported from the existing guard, not redefined). */
export { CENTRAL_DB_NAME, CENTRAL_DB_PATHNAME };
/** Environment variable that holds the legacy connection URL (never argv). */
export const LEGACY_URL_ENV = "LEGACY_VOWASIA_DB_URL";
export const LEGACY_SSL_ENV = "LEGACY_VOWASIA_DB_SSL";
export const LEGACY_CA_ENV = "LEGACY_VOWASIA_DB_CA";
