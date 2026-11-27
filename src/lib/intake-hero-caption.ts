/**
 * Optional hero-image caption on engine intake (`imageCaption`).
 *
 * Central stores whatever it is sent (trimmed, whitespace collapsed, capped at
 * IMAGE_CAPTION_MAX); it does not know any label policy, which lives in the
 * content engine. The caption is written only when the hero Media doc is
 * CREATED (refresh never touches media), in the default locale, exactly like
 * `alt`. When no caption is sent the data object is byte-identical to the old
 * `{ alt, credit }` shape — the `caption` key is not present at all.
 */
import { focalToColumns, isUnsetFocal, parseHeroFocal, type HubHeroFocal } from "@/lib/hub-hero-focal-pure";

export const IMAGE_CAPTION_MAX = 200;

/** Non-string or empty-after-trim ⇒ null; otherwise collapsed and capped. */
export function parseImageCaption(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, IMAGE_CAPTION_MAX).trimEnd();
}

// A type alias (not an interface) so it stays assignable to Record<string, unknown>.
export type HeroMediaData = {
  alt: string;
  credit: string | undefined;
  caption?: string;
  focalX?: number;
  focalY?: number;
};

/**
 * Optional engine-sent hero focal point (`heroFocal: {x, y}`, integers 0-100). Reuses the hub
 * validator `parseHeroFocal`; anything invalid, `null`, or the centre 50/50 ("not set") ⇒ `null`
 * so the intake is never rejected and the media data stays byte-identical to today.
 */
export function parseIntakeHeroFocal(value: unknown): HubHeroFocal | null {
  if (value === undefined) return null;
  const r = parseHeroFocal(value);
  if (!r.ok || r.value === null) return null;
  if (isUnsetFocal(r.value.x, r.value.y)) return null;
  return r.value;
}

/** The `data` passed to `scopedCreate` for the hero Media doc. */
export function buildHeroMediaData(input: {
  title: string;
  credit: string | null;
  caption: string | null;
  focal?: HubHeroFocal | null;
}): HeroMediaData {
  const data: HeroMediaData = { alt: input.title, credit: input.credit ?? undefined };
  if (input.caption !== null) data.caption = input.caption;
  if (input.focal) Object.assign(data, focalToColumns(input.focal));
  return data;
}
