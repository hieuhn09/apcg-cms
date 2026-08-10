import type { CollectionAfterChangeHook, CollectionConfig, FieldHook } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { r2, r2MoveObject, r2ObjectExists } from "@/lib/r2";

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
 * Client uploads strand the ORIGINAL file at the bucket root: with
 * `clientUploads: true` the browser PUTs via a presigned URL that is signed
 * BEFORE this doc (and its `prefix` hook) exists, so the key has no tenant
 * prefix. The imageSizes derivatives are generated server-side during create
 * and DO land under `<prefix>/`. Result: doc says `prefix=brief-asia`, the
 * original sits at `<filename>`, and `/api/media/file/<filename>` 404s — every
 * admin-uploaded image was broken this way (verified live 10-08-2026, three
 * stranded objects). Server-side uploads (engine intake, REST with file bytes)
 * are unaffected — the storage plugin writes those with the prefix.
 *
 * Fix: after create, if the object is missing at its prefixed key but present
 * at the bare filename, move it into place. Best-effort: a failure logs and
 * leaves the doc intact (bytes still recoverable at the root key).
 */
const relocateStrandedUpload: CollectionAfterChangeHook = async ({ doc, operation, req }) => {
  if (operation !== "create" || !r2) return doc;
  const { prefix, filename } = doc as { prefix?: string; filename?: string };
  if (!prefix || !filename) return doc;
  try {
    const wantKey = `${prefix}/${filename}`;
    if (await r2ObjectExists(wantKey)) return doc; // server-side upload: already right
    if (await r2ObjectExists(filename)) {
      await r2MoveObject(filename, wantKey);
      req.payload.logger.info(`media: relocated client upload ${filename} -> ${wantKey}`);
    }
  } catch (err) {
    req.payload.logger.warn(
      `media: failed to relocate client upload ${filename}: ${(err as Error).message}`,
    );
  }
  return doc;
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
    /**
     * Image bytes are PUBLIC; write access stays tenant-scoped.
     *
     * This is structural, not a convenience. A reader's browser loads images
     * from `<img src>`, which cannot carry the tenant's Bearer read token — the
     * token only ever reaches the JSON API. With the tenant-scoped read here,
     * `/api/media/file/<name>?prefix=<tenant>` answered 403 to every anonymous
     * request, so the article JSON came back perfect and every image on the page
     * was broken. Verified against the live deploy before this change.
     *
     * Nothing is exposed that was not already public: these are the hero images
     * of published articles, served openly by each source site today. Upload,
     * update and delete remain restricted to the owning tenant's editors.
     */
    read: () => true,
  },
  hooks: {
    afterChange: [relocateStrandedUpload],
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
