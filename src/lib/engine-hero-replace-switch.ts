/**
 * Engine hero replace (media-gtp-vowasia phase 5): the ONLY reader of the route's env
 * switches. Every value is read on each call (no cache), so the owner turns the route on
 * or off with a Vercel env change + Redeploy and nothing else.
 *
 *   ENGINE_HERO_REPLACE_TENANTS      CSV of CMS tenant slugs, exact (case-sensitive) match.
 *                                    Unset / empty = OFF: every tenant answers 403
 *                                    `feature_disabled` before any article read.
 *   ENGINE_HERO_REPLACE_URL_HOSTS    CSV of exact hostnames the hero URL may point at
 *                                    (case-insensitive). Empty = any public https host.
 *                                    Security control: the owner sets it to the engine's
 *                                    Supabase storage host BEFORE enabling a tenant.
 *   ENGINE_HERO_REPLACE_ALLOW_LOCAL  "true" relaxes http + loopback/private addresses for the
 *                                    LOCAL probe only; ignored whenever VERCEL_ENV is set or
 *                                    NODE_ENV is "production".
 */
type Env = Record<string, string | undefined>;

function csv(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function heroReplaceTenants(env: Env = process.env): string[] {
  return csv(env.ENGINE_HERO_REPLACE_TENANTS);
}

export function isHeroReplaceTenant(slug: string, env: Env = process.env): boolean {
  return heroReplaceTenants(env).includes(slug);
}

export function heroReplaceUrlHosts(env: Env = process.env): string[] {
  return csv(env.ENGINE_HERO_REPLACE_URL_HOSTS).map((h) => h.toLowerCase());
}

export function heroReplaceAllowLocal(env: Env = process.env): boolean {
  if (env.ENGINE_HERO_REPLACE_ALLOW_LOCAL !== "true") return false;
  if (typeof env.VERCEL_ENV === "string" && env.VERCEL_ENV !== "") return false;
  if (env.NODE_ENV === "production") return false;
  return true;
}
