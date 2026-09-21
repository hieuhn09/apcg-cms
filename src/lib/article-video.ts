/**
 * Server-side resolution of an article's video into the flat object the public
 * article API returns.
 *
 * Exists so the READER does no lookups and no branching (Criterion 16): the
 * reader receives `{ url, mimeType, posterUrl, caption, credit, description }`
 * or `null`, never a raw Payload relation it has to resolve itself.
 *
 * Called only from the single-article route, which fetches at depth 2 — so both
 * `video` and `heroImage` arrive as populated docs. An id-only or absent `video`
 * yields `null`, which is also the non-video-article case.
 */

export interface ResolvedArticleVideo {
  url: string;
  mimeType: string;
  posterUrl: string;
  caption: string | null;
  credit: string | null;
  description: string;
}

interface PopulatedUpload {
  url?: string | null;
  mimeType?: string | null;
  sizes?: Record<string, { url?: string | null } | undefined> | null;
}

const asPopulated = (v: unknown): PopulatedUpload | null =>
  v != null && typeof v === "object" ? (v as PopulatedUpload) : null;

export function resolveArticleVideo(doc: unknown): ResolvedArticleVideo | null {
  const a = doc as Record<string, unknown> | null;
  if (!a) return null;

  const video = asPopulated(a.video);
  if (!video) return null;

  const hero = asPopulated(a.heroImage);
  // `hero` is the largest still Media generates; fall back to the original.
  const posterUrl = hero?.sizes?.hero?.url ?? hero?.url ?? "";

  return {
    url: video.url ?? "",
    mimeType: video.mimeType ?? "",
    posterUrl: posterUrl ?? "",
    caption: (a.videoCaption as string | null | undefined) ?? null,
    credit: (a.videoCredit as string | null | undefined) ?? null,
    description: (a.videoDescription as string | null | undefined) ?? "",
  };
}
