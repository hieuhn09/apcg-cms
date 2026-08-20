/** Tiny JSON Response helper shared by all custom route handlers. */
export function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/** kebab-case slugify — ASCII fold, strip non-alphanumerics, collapse dashes.
 * Diacritics fold into their base letter (Málaga → malaga, not ma-laga),
 * apostrophes are dropped (Spain's → spains, not spain-s), and the length
 * cap trims at a word boundary instead of mid-word. */
export function slugify(input: string, maxLen = 96): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0027\u2018\u2019\u02bc\u0060]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= maxLen) return slug;
  const cut = slug.slice(0, maxLen + 1);
  const boundary = cut.lastIndexOf("-");
  return (boundary > 0 ? cut.slice(0, boundary) : slug.slice(0, maxLen)).replace(/-+$/g, "");
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
