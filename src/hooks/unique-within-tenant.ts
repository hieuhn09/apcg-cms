/**
 * Per-tenant uniqueness enforcement.
 *
 * brief-asia marks `slug` as globally `unique: true`. In a multi-tenant DB that
 * is wrong — two publications may legitimately use the same slug. We instead
 * enforce uniqueness WITHIN a tenant:
 *   1. this beforeValidate hook (application-level, always works), and
 *   2. a composite DB index `UNIQUE (tenant_id, <field>)` added by migration
 *      (the real constraint; see docs/migration and the generated migration).
 *
 * The hook closes the common case; the DB index closes the race window.
 */

import type { FieldHook } from "payload";

export function uniqueWithinTenant(fieldName: string, scopeFields: string[] = []): FieldHook {
  return async ({ value, data, originalDoc, req, collection }) => {
    if (value == null || value === "") return value;
    const tenant = data?.tenant ?? originalDoc?.tenant;
    if (tenant == null || !collection) return value;

    // Extra scoping (e.g. subsections are unique per tenant AND pillar). A
    // missing scope value skips the check rather than matching everything.
    const scopeClauses = [];
    for (const scopeField of scopeFields) {
      const scopeValue = data?.[scopeField] ?? originalDoc?.[scopeField];
      if (scopeValue == null || scopeValue === "") return value;
      scopeClauses.push({ [scopeField]: { equals: scopeValue } });
    }

    const existing = await req.payload.find({
      collection: collection.slug as Parameters<typeof req.payload.find>[0]["collection"],
      where: {
        and: [
          { tenant: { equals: tenant } },
          { [fieldName]: { equals: value } },
          ...scopeClauses,
        ],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    });

    const clash = existing.docs.find(
      (d) => (d as { id: unknown }).id !== originalDoc?.id,
    );
    if (clash) {
      throw new Error(
        `${fieldName} "${String(value)}" already exists for this tenant. Choose a unique ${fieldName}.`,
      );
    }
    return value;
  };
}
