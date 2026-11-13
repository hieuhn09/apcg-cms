import { MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * AsiaMaterialsBrief "The Exhibition" (amb launch W2, 27-10-26): the `booths`
 * collection (20261022, built for AsiaBeautyBrief) is reused, so the hall enum
 * gains the four AMB halls that have no matching value yet. AMB also uses the
 * existing `manufacturers` and `services`. Which halls a tenant may use is a
 * code rule (src/lib/booth-halls.ts BOOTH_HALLS_BY_TENANT + the `hall` field
 * validate), not a schema change.
 *
 * ADDITIVE ONLY: `ALTER TYPE ... ADD VALUE IF NOT EXISTS` on
 * `enum_booths_hall` (the type created by 20261022). No table, column, row or
 * existing value changes; idempotent. Postgres 12+ accepts ADD VALUE inside the
 * migration transaction (the new values are just not usable until it commits,
 * and nothing here uses them).
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  ALTER TYPE "public"."enum_booths_hall" ADD VALUE IF NOT EXISTS 'brands';
  ALTER TYPE "public"."enum_booths_hall" ADD VALUE IF NOT EXISTS 'design-studios';
  ALTER TYPE "public"."enum_booths_hall" ADD VALUE IF NOT EXISTS 'distributors-showrooms';
  ALTER TYPE "public"."enum_booths_hall" ADD VALUE IF NOT EXISTS 'country-pavilions';`)
}

/**
 * Documented NO-OP: Postgres cannot drop a value from an enum type. Removing the
 * four values would mean recreating `enum_booths_hall` and rewriting
 * `booths.hall`, which is not worth the risk for unused labels; after a code
 * rollback the extra values simply stay unused (the old code's select options
 * do not offer them). `down` of 20261022 still drops the whole type.
 */
export async function down(): Promise<void> {
  // Intentionally empty (see above).
}
