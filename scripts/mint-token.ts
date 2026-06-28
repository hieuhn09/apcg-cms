/**
 * Mint a per-tenant READ token (for a frontend) or an ENGINE token. Prints the
 * raw token ONCE and stores only its hash. Copy it immediately.
 *
 *   npm run payload -- # not this; use tsx directly:
 *   tsx scripts/mint-token.ts read   --tenant brief-asia --label frontend
 *   tsx scripts/mint-token.ts engine --engine "content-engine"
 */
import "./lib/env";
import { randomBytes } from "node:crypto";
import { getPayload } from "payload";
import config from "../payload.config";
import { hashToken } from "../src/lib/crypto";
import { pFind, pUpdate } from "./lib/payload-loose";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const kind = process.argv[2];
  const payload = await getPayload({ config });
  const raw = randomBytes(24).toString("hex");
  const { hash, prefix } = hashToken(raw);

  if (kind === "read") {
    const tenantSlug = arg("--tenant");
    if (!tenantSlug) throw new Error("--tenant <slug> required");
    const label = arg("--label") || "frontend";
    const tenant = ((await pFind(payload, "tenants", { where: { slug: { equals: tenantSlug } }, limit: 1, depth: 0 })) as { docs: { id: number | string; readTokens?: unknown[] }[] }).docs[0];
    if (!tenant) throw new Error(`Tenant ${tenantSlug} not found`);
    const tokens = Array.isArray(tenant.readTokens) ? tenant.readTokens : [];
    await pUpdate(payload, "tenants", tenant.id, { readTokens: [...tokens, { label, tokenHash: hash, tokenPrefix: prefix, status: "active" }] });
    console.log(`READ token for ${tenantSlug} (copy now): ${raw}`);
  } else if (kind === "engine") {
    const name = arg("--engine");
    if (!name) throw new Error('--engine "<name>" required');
    const engine = ((await pFind(payload, "content-engines", { where: { name: { equals: name } }, limit: 1, depth: 0 })) as { docs: { id: number | string }[] }).docs[0];
    if (!engine) throw new Error(`Engine ${name} not found`);
    // rawToken is a virtual field hashed by the collection's beforeChange hook.
    await pUpdate(payload, "content-engines", engine.id, { rawToken: raw });
    console.log(`ENGINE token for ${name} (copy now): ${raw}`);
  } else {
    console.error("usage: tsx scripts/mint-token.ts <read|engine> [--tenant slug|--engine name] [--label x]");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[mint-token] failed", err);
  process.exit(1);
});
