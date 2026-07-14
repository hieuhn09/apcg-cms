import type { CollectionConfig } from "payload";
import { tenantManagedAccess } from "@/access/collections";
import { featureGatedAccess } from "@/access/features";

/**
 * SponsorSlots — per-tenant, feature-gated (`sponsorSlots`). Two models coexist,
 * switched by `slot`:
 *   - article-linked ad placement (BA/DTW): homepage_strip / dashboard_* + article.
 *   - free-text promo card (WTB): slot=promo_card + headline/body/CTA.
 * `admin.condition` keys on the `slot` field value (not the tenant), so it is a
 * reliable admin-UI switch. Import sets slot=promo_card for every WTB row.
 */
export const SponsorSlots: CollectionConfig = {
  slug: "sponsorSlots",
  admin: { useAsTitle: "slot", defaultColumns: ["slot", "article", "startsAt", "endsAt"], group: "Commercial" },
  access: featureGatedAccess("sponsorSlots", tenantManagedAccess),
  fields: [
    {
      name: "slot",
      type: "select",
      required: true,
      options: [
        { label: "Homepage strip", value: "homepage_strip" },
        { label: "Dashboard — funding", value: "dashboard_funding" },
        { label: "Dashboard — AI", value: "dashboard_ai" },
        { label: "Promo card (free-text)", value: "promo_card" },
      ],
    },
    // ── Article-linked model (BA/DTW) ──
    { name: "article", type: "relationship", relationTo: "articles", admin: { condition: (data) => data?.slot !== "promo_card", description: "Empty = slot renders nothing." } },
    { name: "startsAt", type: "date", admin: { condition: (data) => data?.slot !== "promo_card", date: { pickerAppearance: "dayAndTime" } } },
    { name: "endsAt", type: "date", admin: { condition: (data) => data?.slot !== "promo_card", date: { pickerAppearance: "dayAndTime" } } },
    // ── Free-text promo card (WTB) ──
    { name: "name", type: "text", admin: { condition: (data) => data?.slot === "promo_card", description: "Internal label for this promo card." } },
    { name: "headline", type: "text", localized: true, admin: { condition: (data) => data?.slot === "promo_card" } },
    { name: "body", type: "textarea", localized: true, admin: { condition: (data) => data?.slot === "promo_card" } },
    { name: "ctaLabel", type: "text", localized: true, admin: { condition: (data) => data?.slot === "promo_card" } },
    { name: "ctaUrl", type: "text", admin: { condition: (data) => data?.slot === "promo_card" } },
    { name: "active", type: "checkbox", defaultValue: false, admin: { condition: (data) => data?.slot === "promo_card" } },
  ],
};
