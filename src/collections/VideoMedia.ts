import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";
import {
  prefixFromSelectedTenant,
  rememberSignedFilename,
  tenantKeyPrefix,
  verifyClientUpload,
} from "@/lib/upload-integrity";

/**
 * VideoMedia — per-tenant short-form video uploads, feature-gated (`video`).
 *
 * A SEPARATE collection rather than widening `Media.mimeTypes`, on purpose:
 * `Media` runs every upload through sharp to build three imageSizes, and a
 * video reaching that path is a hard failure for a collection every tenant
 * depends on. Keeping video in its own collection means the mimetype blast
 * radius is exactly this file — no existing upload field's `relationTo` widens.
 *
 * Deliberately carries NO bespoke fields beyond `prefix` (caption / credit /
 * description live on the Article, next to the rest of its editorial copy).
 * It is pure file storage.
 *
 * Upload integrity (presigned-key verification, per-tenant key prefixing) is
 * IMPORTED from `@/lib/upload-integrity`, shared byte-for-byte with `Media` —
 * see that module for why a copy would be a regression waiting to happen.
 */
export const VideoMedia: CollectionConfig = {
  slug: "videoMedia",
  admin: { useAsTitle: "filename", group: "Editorial" },
  access: featureGatedAccess("video", tenantManagedAccess),
  hooks: {
    beforeChange: [rememberSignedFilename],
    afterChange: [verifyClientUpload],
  },
  upload: {
    // video/* only, and NO `imageSizes` key at all — there are no derivatives
    // to generate and sharp must never be handed a video stream.
    mimeTypes: ["video/*"],
  },
  fields: [
    {
      // Same shape as Media.prefix, same shared hooks: declared here rather
      // than left to storage-s3's field injection so the column exists whether
      // or not R2 env vars are present.
      name: "prefix",
      type: "text",
      index: true,
      admin: { hidden: true, readOnly: true },
      defaultValue: prefixFromSelectedTenant,
      hooks: { beforeValidate: [tenantKeyPrefix] },
    },
  ],
};
