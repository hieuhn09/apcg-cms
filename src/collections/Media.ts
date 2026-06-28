import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";

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
  ],
};
