import { randomBytes } from "node:crypto";
import { getPayload } from "payload";
import config from "../../../../../payload.config";
import { hashToken } from "../../../../../src/lib/crypto";
import { pCreate, pFind } from "../../../../lib/payload-loose";
import { assertLocalDb } from "../../../../lib/local-db-guard";

type Doc = Record<string, unknown>;
const ctx = { disableRevalidate: true, skipTranslationEnqueue: true };
export const AER_PILLARS = [
  ["asia-watch", "Asia Watch"], ["briefings", "Briefings"], ["corporate-asia", "Corporate Asia"],
  ["interviews", "The Review Interview"], ["long-view", "The Long View"], ["in-focus", "In Focus"],
] as const;
export const AER_SUBS = [["asia-watch", "growth-policy", "Growth & Policy"], ["briefings", "markets", "Markets"], ["corporate-asia", "capital", "Capital"]] as const;
export const AER_AUTHORS = ["Lena Ho", "Arjun Menon", "Mei Fong Chua", "Rahul Sethi"] as const;

async function main(): Promise<void> {
  assertLocalDb(process.env.DATABASE_URL);
  const payload = await getPayload({ config });
  const find = async (c: string, where: Doc, draft = false) => ((await pFind(payload, c, { where, limit: 1000, ...(draft ? { draft: true } : {}) })) as unknown as { docs: Doc[]; totalDocs: number });
  const action = process.argv[2];
  let tenant = (await find("tenants", { slug: { equals: "aer" } })).docs[0];
  if (action === "setup") {
    if (!tenant) {
      const raw = randomBytes(24).toString("hex");
      const { hash, prefix } = hashToken(raw);
      tenant = (await pCreate(payload, "tenants", { slug: "aer", name: "[FIXTURE] Asia Economic Review", status: "active", defaultLanguage: "en", supportedLanguages: ["en"], features: { articles: true }, readTokens: [{ label: "frontend", tokenHash: hash, tokenPrefix: prefix, status: "active" }] }, { context: ctx })) as unknown as Doc;
      console.log(`READ_TOKEN ${raw}`);
    }
    const pid = new Map<string, unknown>();
    let order = 1;
    for (const [slug, title] of AER_PILLARS) {
      const hit = (await find("pillars", { and: [{ tenant: { equals: tenant.id } }, { slug: { equals: slug } }] })).docs[0];
      pid.set(slug, hit?.id ?? ((await pCreate(payload, "pillars", { tenant: tenant.id, slug, title, order: order }, { context: ctx, locale: "en" })) as unknown as Doc).id);
      order++;
    }
    for (const [p, slug, title] of AER_SUBS) {
      const hit = (await find("subsections", { and: [{ tenant: { equals: tenant.id } }, { slug: { equals: slug } }] })).docs[0];
      if (!hit) await pCreate(payload, "subsections", { tenant: tenant.id, pillar: pid.get(p), slug, title, order: 1 }, { context: ctx, locale: "en" });
    }
    for (const name of AER_AUTHORS) {
      const hit = (await find("authors", { and: [{ tenant: { equals: tenant.id } }, { name: { equals: name } }] })).docs[0];
      if (!hit) await pCreate(payload, "authors", { tenant: tenant.id, name, slug: name.toLowerCase().replace(/ /g, "-"), role: "Writer" }, { context: ctx });
    }
  }
  if (!tenant) throw new Error("tenant aer missing");
  const arts = (await find("articles", { tenant: { equals: tenant.id } }, true)).docs;
  const by = (k: (d: Doc) => string) => arts.reduce<Record<string, number>>((m, d) => ((m[k(d)] = (m[k(d)] ?? 0) + 1), m), {});
  const rel = (v: unknown) => (v && typeof v === "object" ? String((v as Doc).slug ?? (v as Doc).name ?? (v as Doc).id) : String(v));
  console.log(`RESULT ${JSON.stringify({ tenant: tenant.id, articles: arts.length, byStatus: by((d) => String(d.workflowStatus)), byPillar: by((d) => rel(d.pillar)), byAuthor: by((d) => rel(d.author)), withHero: arts.filter((d) => d.heroImage).length, tags: (await find("tags", { tenant: { equals: tenant.id } })).totalDocs })}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
