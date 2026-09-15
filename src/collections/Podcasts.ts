import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";
import { uniqueWithinTenant } from "@/hooks/unique-within-tenant";
import { extractYoutubeId } from "@/lib/youtube";

/** Podcasts — per-tenant, feature-gated (`podcasts`). */
export const Podcasts: CollectionConfig = {
  slug: "podcasts",
  admin: { useAsTitle: "title", defaultColumns: ["title", "show", "episode", "publishedAt"], group: "Editorial" },
  access: featureGatedAccess("podcasts", tenantManagedAccess),
  fields: [
    { name: "show", type: "text" },
    { name: "episode", type: "text" },
    { name: "title", type: "text", required: true, localized: true },
    { name: "slug", type: "text", required: true, index: true, hooks: { beforeValidate: [uniqueWithinTenant("slug")] } },
    { name: "description", type: "textarea", localized: true },
    { name: "duration", type: "text" },
    { name: "host", type: "text" },
    { name: "tag", type: "text", localized: true, admin: { description: "e.g. On location · Tokyo (WTB)." } },
    { name: "poster", type: "upload", relationTo: "media", admin: { description: "Episode poster image (WTB)." } },
    {
      // An episode IS a YouTube video: required, and validated as parseable at
      // save time so no document can ever render an empty player. Not localized
      // — a YouTube link is identical in every locale (same reasoning as
      // `heroImage`/`exclusive` on Articles).
      name: "youtubeUrl",
      type: "text",
      required: true,
      admin: {
        description: "YouTube link for this episode. watch?v= / youtu.be / live / shorts all accepted.",
        placeholder: "https://youtube.com/watch?v=...",
      },
      hooks: {
        beforeValidate: [
          ({ value, siblingData }) => {
            const raw = typeof value === "string" ? value.trim() : "";
            if (raw === "") {
              throw new Error("YouTube URL is required.");
            }
            const id = extractYoutubeId(raw);
            if (id == null) {
              throw new Error(
                `"${raw}" is not a valid YouTube video link. Use a youtube.com/watch?v=, youtu.be/, /live/ or /shorts/ URL.`,
              );
            }
            // Derive once here so every consumer (thumbnail URL, embed src)
            // is a plain string interpolation with no duplicated regex.
            (siblingData as Record<string, unknown>).youtubeId = id;
            return raw;
          },
        ],
      },
    },
    {
      // Derived from `youtubeUrl` above — never hand-edited.
      name: "youtubeId",
      type: "text",
      admin: { readOnly: true, description: "Derived from the YouTube URL. Read-only." },
    },
    {
      name: "audioUrl",
      type: "text",
      // Dormant, not dead: YouTube is the only publishing path for now, so the
      // column and its data stay untouched while the field is hidden from
      // editors (and removed from the console create form). Un-hiding is a
      // one-line revert if a tenant needs self-hosted audio later.
      admin: { hidden: true, description: "Audio file URL (object storage). Dormant — YouTube is the publishing path." },
    },
    { name: "publishedAt", type: "date", admin: { date: { pickerAppearance: "dayAndTime" } } },
  ],
};
