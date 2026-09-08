import type {
  CollectionAfterChangeHook,
  CollectionBeforeChangeHook,
  CollectionConfig,
  FieldHook,
} from "payload";
import { APIError } from "payload";
import { sanitizeFilename } from "payload/shared";
import { getTenantFromCookie } from "@payloadcms/plugin-multi-tenant/utilities";
import { tenantManagedAccess } from "@/access/collections";
import { r2, r2MoveObject, r2ObjectExists } from "@/lib/r2";

/** Resolve a tenant id (from the doc or the admin's tenant cookie) to its slug. */
const tenantSlugById = async (
  req: Parameters<FieldHook>[0]["req"],
  tenant: unknown,
): Promise<string | undefined> => {
  if (tenant == null) return undefined;
  if (typeof tenant === "object" && "slug" in (tenant as object)) {
    return (tenant as { slug: string }).slug;
  }
  const found = await req.payload.findByID({
    collection: "tenants",
    id: tenant as string | number,
    depth: 0,
    overrideAccess: true,
  });
  return (found as { slug?: string } | null)?.slug ?? undefined;
};

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
  return (await tenantSlugById(req, data?.tenant ?? originalDoc?.tenant)) ?? value;
};

/**
 * Seed `prefix` into the CREATE form state so the browser signs the right key.
 *
 * With clientUploads the browser asks for a presigned PUT *before* the doc
 * exists, sending `docPrefix` straight from this field's form value. If that
 * value is empty the object lands at the bucket root while `tenantKeyPrefix`
 * (above) stamps the doc with the tenant slug — the original 11-08-2026
 * stranding. Resolving the same slug here, from the admin's selected-tenant
 * cookie, makes both sides agree before a single byte moves.
 *
 * Server-side creates (engine intake, console actions, scripts) carry no cookie
 * and get `undefined` — `tenantKeyPrefix` fills it in from `data.tenant` as
 * before.
 */
const prefixFromSelectedTenant = async ({
  req,
}: {
  req: Parameters<FieldHook>[0]["req"];
}): Promise<string | undefined> => {
  const tenant = getTenantFromCookie(req.headers, req.payload.db.defaultIDType);
  if (!tenant) return undefined;
  try {
    return await tenantSlugById(req, tenant);
  } catch {
    return undefined;
  }
};

/**
 * Remember the filename the BROWSER signed, before Payload re-sanitizes it.
 *
 * `generateFileData` runs the incoming name through the `sanitize-filename`
 * package (which strips trailing spaces/dots, among others) while the
 * presigned-URL handler only ran Payload's own `sanitizeFilename` (path +
 * control chars). So "SAC .JPG" is signed as `SAC .JPG` and stored on the doc
 * as `SAC.JPG` — the exact divergence that broke four editor uploads on
 * 11-08-2026, and still present in payload 3.85.1. `req.file.name` is the
 * pre-sanitize name, so stash it while it is still around.
 */
const rememberSignedFilename: CollectionBeforeChangeHook = ({ data, operation, req }) => {
  if (operation === "create" && req.file?.clientUploadContext) {
    req.context.signedUploadFilename = req.file.name;
  }
  return data;
};

/**
 * Verify a browser-uploaded original actually sits at the key the doc points
 * at, and move it there if not.
 *
 * Only client uploads are checked: the browser PUT the bytes before this create
 * request, so the object must already exist. Server-side uploads are written by
 * the storage plugin's own afterChange hook, which the plugin APPENDS after
 * this one — nothing would be there to find yet, so they are skipped.
 *
 * A miss that cannot be repaired throws rather than warns. The doc row is
 * written inside the create transaction, so throwing rolls it back: the editor
 * gets a real error instead of a media entry whose image silently 404s (how the
 * 11-08-2026 breakage stayed invisible until readers hit it). The orphaned blob
 * left in R2 is the cheaper failure.
 */
const verifyClientUpload: CollectionAfterChangeHook = async ({ doc, operation, req }) => {
  if (operation !== "create" || !r2) return doc;
  if (!req.file?.clientUploadContext) return doc;

  const { prefix, filename } = doc as { prefix?: string; filename?: string };
  if (!filename) return doc;

  const wantKey = prefix ? `${prefix}/${filename}` : filename;
  if (await r2ObjectExists(wantKey)) return doc;

  // Every key the browser could plausibly have signed, most likely first: the
  // pre-sanitize name under this prefix, then the same names at the bucket root
  // (no prefix reached the form — e.g. no tenant cookie).
  const signedName = req.context.signedUploadFilename as string | undefined;
  // The key itself was built as sanitizeFilename(signedName) — same value in
  // every ordinary case, but it also strips directory components, so a name
  // carrying a slash keys differently from what the doc recorded.
  let keyedName: string | undefined;
  try {
    keyedName = signedName ? sanitizeFilename(signedName) : undefined;
  } catch {
    keyedName = undefined;
  }
  const candidates = [
    prefix && signedName ? `${prefix}/${signedName}` : null,
    prefix && keyedName ? `${prefix}/${keyedName}` : null,
    signedName ?? null,
    keyedName ?? null,
    prefix ? filename : null,
  ].filter((key): key is string => Boolean(key) && key !== wantKey);

  for (const fromKey of candidates) {
    if (await r2ObjectExists(fromKey)) {
      await r2MoveObject(fromKey, wantKey);
      req.payload.logger.info(`media: relocated client upload ${fromKey} -> ${wantKey}`);
      return doc;
    }
  }

  throw new APIError(
    `Upload failed: the image did not reach storage at "${wantKey}". Please retry, ` +
      `renaming the file if it contains unusual characters.`,
    400,
  );
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
    beforeChange: [rememberSignedFilename],
    afterChange: [verifyClientUpload],
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
      defaultValue: prefixFromSelectedTenant,
      hooks: { beforeValidate: [tenantKeyPrefix] },
    },
  ],
};
