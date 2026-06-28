/**
 * Locale configuration for the Central CMS.
 *
 * Payload's `localization.locales` list is GLOBAL — it cannot vary per tenant.
 * So we declare the full set the platform understands here, and each tenant
 * additionally declares its own `supportedLanguages` subset (a field on the
 * Tenants collection). The per-tenant subset is enforced in app logic:
 *   - the admin locale switcher only offers the tenant's supported locales,
 *   - translation-job creation clamps targets to the supported subset,
 *   - the public API clamps `?locale=` to the supported subset (falling back to
 *     the tenant's defaultLanguage).
 *
 * This mirrors brief-asia's 8 active locales. Adding a locale here makes it
 * available platform-wide; tenants opt in via `supportedLanguages`.
 */

export const LOCALE_CODES = [
  "en",
  "vi",
  "th",
  "id",
  "ja",
  "ko",
  "zh-hant",
  "zh-hans",
] as const;

export type LocaleCode = (typeof LOCALE_CODES)[number];

export const DEFAULT_LOCALE: LocaleCode = "en";

export const LOCALE_LABELS: Record<LocaleCode, string> = {
  en: "English",
  vi: "Tiếng Việt",
  th: "ไทย",
  id: "Bahasa Indonesia",
  ja: "日本語",
  ko: "한국어",
  "zh-hant": "繁體中文",
  "zh-hans": "简体中文",
};

/** Payload `localization.locales` entry shape. */
export const PAYLOAD_LOCALES = LOCALE_CODES.map((code) => ({
  code,
  label: LOCALE_LABELS[code],
}));

export function isLocaleCode(value: unknown): value is LocaleCode {
  return (
    typeof value === "string" && (LOCALE_CODES as readonly string[]).includes(value)
  );
}

/**
 * Clamp a requested locale to a tenant's supported subset. Returns the requested
 * locale if supported, otherwise the tenant's default, otherwise the platform
 * default. Never returns a locale the tenant did not opt into.
 */
export function clampLocale(
  requested: unknown,
  supported: readonly string[],
  tenantDefault: string,
): LocaleCode {
  const fallback = (isLocaleCode(tenantDefault) ? tenantDefault : DEFAULT_LOCALE) as LocaleCode;
  if (
    isLocaleCode(requested) &&
    supported.includes(requested) &&
    LOCALE_CODES.includes(requested)
  ) {
    return requested;
  }
  return supported.includes(fallback) ? fallback : DEFAULT_LOCALE;
}
