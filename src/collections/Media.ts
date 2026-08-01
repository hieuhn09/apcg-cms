import type { CollectionConfig, FieldHook } from "payload";
import { tenantManagedAccess } from "@/access/collections";

/**
 * Resolve the R2 key prefix for an upload: the owning tenant's slug.
 *
 * storage-s3 builds the object key as `<doc.prefix>/<filename>` (docPrefix wins
 * over any collection-level prefix when useCompositePrefixes is off), and it
 * reuses the same prefix for every derivative. That is exactly the layout
 * `scripts/migrate/copy-media.ts` writes (`<tenant>/<key>`), so pre-copied
 * objects resolve without a second pass. The two MUST stay in step: change one
 * and every imported image 404s.
 *
 * The prefix is written once, on create, and then left alone — rewriting it on
 * a later update would move the expected key while the stored object stays put.
 */
const tenantKeyPrefix: FieldHook = async ({ value, data, originalDoc, operation, req }) => {
  if (operation !== "create") return originalDoc?.prefix ?? value;
  if (typeof value === "string" && value !== "") return value;

  const tenant = data?.tenant ?? originalDoc?.tenant;
  if (tenant == null) return value;
  if (typeof tenant === "object" && "slug" in tenant) return (tenant as { slug: string }).slug;

  const found = await req.payload.findByID({
    collection: "tenants",
    id: tenant as string | number,
    depth: 0,
    overrideAccess: true,
  });
  return (found as { slug?: string } | null)?.slug ?? value;
};

/**
 * Media — per-tenant uploads. The `tenant` field is added by the multi-tenant
 * plugin, so the admin only ever lists/edits media for the selected tenant and
 * the public API only serves a tenant its own media.
 *
 * Storage: one central R2 bucket (configured in payload.config via storage-s3).
 * Tenant isolation here is about WHO can manage media and WHICH tenant's media
 * the API lists — published image bytes are public by nature (served via CDN).
 * The migration copy-media script lays imported objects out under per-tenant key
 * prefixes; see docs/migration.
 *
 * alt + caption are localized (brief-asia's alt was not) so a tenant can ship
 * accessible, per-language image text.
 */
export const Media: CollectionConfig = {
  slug: "media",
  admin: { useAsTitle: "alt", group: "Editorial" },
  access: {
    ...tenantManagedAccess,
    // Anyone in the tenant may upload; brief-asia parity.
    read: tenantManagedAccess.read,
  },
  upload: {
    mimeTypes: ["image/*"],
    imageSizes: [
      { name: "thumbnail", width: 400 },
      { name: "card", width: 800 },
      { name: "hero", width: 1600 },
    ],
  },
  fields: [
    { name: "alt", type: "text", required: true, localized: true, admin: { description: "Alt text — required (WCAG 2.1 AA)." } },
    { name: "caption", type: "text", localized: true },
    { name: "credit", type: "text", admin: { description: "Photographer / source credit." } },
    {
      // Declared here rather than left to storage-s3's field injection so the
      // column exists whether or not R2 env vars are present — the plugin is
      // env-gated in payload.config, and an env-dependent schema is how the
      // admin bundle drifts between environments.
      name: "prefix",
      type: "text",
      index: true,
      admin: { hidden: true, readOnly: true },
      hooks: { beforeValidate: [tenantKeyPrefix] },
    },
  ],
};
