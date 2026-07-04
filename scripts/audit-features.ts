/**
 * Print each tenant's feature flags + languages (no secrets in output).
 * Read-only audit used when reviewing per-site feature configuration.
 *
 *   npx tsx scripts/audit-features.ts
 */
import "./lib/env";
import { getPayload } from "payload";
import config from "../payload.config";

async function main() {
  const payload = await getPayload({ config });
  const res = await payload.find({
    collection: "tenants",
    depth: 0,
    pagination: false,
    overrideAccess: true,
    sort: "id",
  });
  for (const t of res.docs as unknown as Array<Record<string, unknown>>) {
    console.log(
      JSON.stringify(
        {
          id: t.id,
          slug: t.slug,
          name: t.name,
          status: t.status,
          defaultLanguage: t.defaultLanguage,
          supportedLanguages: t.supportedLanguages,
          features: t.features,
        },
        null,
        2,
      ),
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
