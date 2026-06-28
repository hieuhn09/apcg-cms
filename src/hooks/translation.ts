/**
 * enqueueTranslations — afterChange hook on Articles. When a published article's
 * source content is ready, queue translation jobs for the tenant's supported
 * target languages and mark those locales `pending`. Protected (approved/locked)
 * translations are never re-queued; `outdated`/`none`/`failed` are.
 *
 * Recursion guard: it writes back translationStatus with
 * context.skipTranslationEnqueue so its own update doesn't re-trigger.
 */
import type { CollectionAfterChangeHook } from "payload";
import { findTenantById, featureEnabled, supportedLanguages } from "@/lib/tenant";
import { toId } from "@/access/helpers";
import { logActivity } from "@/lib/activity";
import { PROTECTED_TRANSLATION_STATES } from "@/lib/constants";

interface StatusRow {
  locale: string;
  state: string;
  sourceVersionAtTranslation?: number;
  [k: string]: unknown;
}

export const enqueueTranslations: CollectionAfterChangeHook = async ({ doc, req }) => {
  const ctx = (req.context as { skipTranslationEnqueue?: boolean }) ?? {};
  if (ctx.skipTranslationEnqueue) return doc;
  if (doc.workflowStatus !== "published") return doc;

  const tenantId = toId(doc.tenant);
  if (tenantId == null) return doc;
  const tenant = await findTenantById(req.payload, tenantId);
  if (!tenant || !featureEnabled(tenant, "translations")) return doc;

  const source = (doc.sourceLanguage as string) || tenant.defaultLanguage;
  const targets = supportedLanguages(tenant).filter((l) => l !== source);
  if (!targets.length) return doc;

  const rows: StatusRow[] = Array.isArray(doc.translationStatus) ? [...doc.translationStatus] : [];
  const version = typeof doc.version === "number" ? doc.version : 1;
  let changed = false;

  for (const locale of targets) {
    const row = rows.find((r) => r.locale === locale);
    if (row && PROTECTED_TRANSLATION_STATES.includes(row.state as never)) continue; // never auto re-translate
    if (row && (row.state === "machine_translated" || row.state === "needs_review")) {
      // already translated at the current source version → up-to-date; skip.
      if (row.sourceVersionAtTranslation === version) continue;
    }

    // Idempotent job: one per (article, targetLocale, sourceVersion).
    const existing = await req.payload.find({
      collection: "translationJobs",
      where: {
        and: [
          { article: { equals: doc.id } },
          { targetLocale: { equals: locale } },
          { sourceVersion: { equals: version } },
        ],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    });
    if (!existing.docs.length) {
      await req.payload.create({
        collection: "translationJobs",
        overrideAccess: true,
        data: {
          tenant: tenantId,
          article: doc.id,
          sourceLocale: source,
          targetLocale: locale,
          status: "queued",
          sourceVersion: version,
          attempts: 0,
        },
      });
      await logActivity({
        payload: req.payload,
        eventType: "translation_queued",
        tenantId,
        actorType: req.user ? "human" : "system",
        targetCollection: "articles",
        targetId: doc.id,
        detail: { locale, sourceVersion: version },
      });
    }

    if (row) {
      row.state = "pending";
    } else {
      rows.push({ locale, state: "pending" });
    }
    changed = true;
  }

  if (changed) {
    await req.payload.update({
      collection: "articles",
      id: doc.id,
      data: { translationStatus: rows },
      context: { skipTranslationEnqueue: true },
      overrideAccess: true,
    });
  }
  return doc;
};
