/**
 * Rehearsal bootstrap step 2 (Amendment 4 §4.4 item 13, E11): creates tenant
 * `vowasia` in the LOCAL Central from `VOWASIA_TENANT_FIELDS`, so the taxonomy
 * script's tenant preflight passes and its `--apply` can create the 49 rows.
 * Refuses any non-local DATABASE_URL (`assertLocalDb`) before Payload loads.
 * Prints `RESULT {"tenantId":...}`.
 */
import "../../../lib/env";
import { assertLocalDb } from "../../../lib/local-db-guard";

async function main(): Promise<void> {
  assertLocalDb(process.env.DATABASE_URL);
  const { getPayload } = await import("payload");
  const { default: config } = await import("../../../../payload.config");
  const { pCreate, pFind } = await import("../../../lib/payload-loose");
  const { VOWASIA_TENANT_FIELDS } = await import("../../../lib/vowasia-taxonomy");
  const payload = await getPayload({ config });
  const found = ((await pFind(payload, "tenants", { where: { slug: { equals: VOWASIA_TENANT_FIELDS.slug } }, limit: 1 })) as unknown as { docs: { id: number }[] }).docs[0];
  if (found) {
    console.log(`RESULT ${JSON.stringify({ tenantId: found.id, created: false })}`);
    return;
  }
  const { domain, frontendUrl, additionalDomains, ...rest } = VOWASIA_TENANT_FIELDS;
  const data = { ...rest, ...(domain ? { domain } : {}), ...(frontendUrl ? { frontendUrl } : {}), ...(additionalDomains.length ? { additionalDomains: additionalDomains.map((d) => ({ domain: d })) } : {}) };
  const t = (await pCreate(payload, "tenants", data as unknown as Record<string, unknown>, { context: { disableRevalidate: true } })) as unknown as { id: number };
  console.log(`RESULT ${JSON.stringify({ tenantId: t.id, created: true })}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[rehearse-bootstrap] ${(err as Error).message}`);
    process.exit(1);
  },
);
