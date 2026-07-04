/**
 * Import a source site's editorial CMS users into Central as tenant members.
 * REST exports carry no password hashes, so each newly created user gets a
 * random temp password, printed ONCE — distribute + have users reset.
 *
 * Role map (source → central membership on the tenant):
 *   admin  → websiteAdmin (canPublish)
 *   editor → editor       (canPublish)
 *   author → contributor  (no publish)
 *
 * Existing central users (matched by email) get the tenant membership appended
 * (their password + global role are untouched). Central's own seed admin email
 * is skipped. Afterwards, authors.user links are re-established by matching the
 * source users export (source user id → email → central user id).
 *
 *   IMPORT_TENANT_SLUG=brief-asia IMPORT_DIR=migration-data/brief-asia \
 *   npm run migrate:users -- [--dry-run]
 */
import "../lib/env";
import { DRY_RUN, requireEnv } from "../lib/env";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { getPayload } from "payload";
import config from "../../payload.config";
import { pFind, pUpdate } from "../lib/payload-loose";

const TENANT_SLUG = requireEnv("IMPORT_TENANT_SLUG");
const IMPORT_DIR = process.env.IMPORT_DIR || path.resolve(process.cwd(), "migration-data", TENANT_SLUG);
const SEED_ADMIN = (process.env.SEED_ADMIN_EMAIL || "").toLowerCase();

type Doc = Record<string, unknown>;

const ROLE_MAP: Record<string, { role: string; canPublish: boolean }> = {
  admin: { role: "websiteAdmin", canPublish: true },
  editor: { role: "editor", canPublish: true },
  author: { role: "contributor", canPublish: false },
};

function read(coll: string): Doc[] {
  const file = path.join(IMPORT_DIR, `${coll}.ndjson`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Doc);
}

interface MembershipRow {
  tenant: number | string;
  roles: string[];
  canPublish: boolean;
}

function readMemberships(doc: Doc): MembershipRow[] {
  const arr = Array.isArray(doc.tenants) ? doc.tenants : [];
  return arr.map((row) => {
    const r = row as { tenant?: unknown; roles?: unknown; canPublish?: unknown };
    const tenant = typeof r.tenant === "object" && r.tenant ? ((r.tenant as { id?: unknown }).id as number | string) : (r.tenant as number | string);
    return { tenant, roles: Array.isArray(r.roles) ? (r.roles as string[]) : [], canPublish: Boolean(r.canPublish) };
  });
}

async function main() {
  const payload = await getPayload({ config });
  const tenant = ((await pFind(payload, "tenants", { where: { slug: { equals: TENANT_SLUG } }, limit: 1 })) as unknown as { docs: Doc[] }).docs[0];
  if (!tenant) throw new Error(`Tenant ${TENANT_SLUG} not found — run seed first.`);
  const tenantId = tenant.id as number | string;

  const sourceUsers = read("users");
  if (!sourceUsers.length) {
    console.log(`[users] no users.ndjson in ${IMPORT_DIR} — nothing to do`);
    process.exit(0);
  }

  // source user id → central user id (for the authors.user re-link below)
  const userIdMap = new Map<unknown, number | string>();
  const tempPasswords: [string, string][] = [];

  for (const u of sourceUsers) {
    const email = String(u.email ?? "").trim().toLowerCase();
    if (!email) continue;
    if (SEED_ADMIN && email === SEED_ADMIN) {
      console.log(`[users] ${email} skipped (central seed admin)`);
      continue;
    }
    const mapped = ROLE_MAP[String(u.role ?? "author")] ?? ROLE_MAP.author!;
    const membership: MembershipRow = { tenant: tenantId, roles: [mapped.role], canPublish: mapped.canPublish };

    const existing = ((await pFind(payload, "users", { where: { email: { equals: email } }, limit: 1, depth: 0 })) as unknown as { docs: Doc[] }).docs[0];
    if (existing) {
      userIdMap.set(u.id, existing.id as number | string);
      const memberships = readMemberships(existing);
      if (memberships.some((m) => String(m.tenant) === String(tenantId))) {
        console.log(`[users] ${email} already a member of ${TENANT_SLUG}`);
        continue;
      }
      memberships.push(membership);
      if (!DRY_RUN) await pUpdate(payload, "users", existing.id as number | string, { tenants: memberships });
      console.log(`[users] ${email} → added ${mapped.role} membership on ${TENANT_SLUG}`);
      continue;
    }

    const password = randomBytes(12).toString("base64url");
    if (!DRY_RUN) {
      const created = await payload.create({
        collection: "users",
        overrideAccess: true,
        data: {
          name: String(u.name ?? email),
          email,
          password,
          role: "standard",
          tenants: [membership],
        } as never,
      });
      userIdMap.set(u.id, (created as { id: number | string }).id);
    }
    tempPasswords.push([email, password]);
    console.log(`[users] ${email} → created (${mapped.role} on ${TENANT_SLUG})`);
  }

  // Re-link authors.user for authors whose source doc carried a user link.
  const sourceAuthors = read("authors");
  let relinked = 0;
  for (const a of sourceAuthors) {
    const sourceUserId = a.user && typeof a.user === "object" ? (a.user as { id?: unknown }).id : a.user;
    if (sourceUserId == null) continue;
    const centralUserId = userIdMap.get(sourceUserId);
    if (centralUserId == null) continue;
    const centralAuthor = ((await pFind(payload, "authors", {
      where: { and: [{ tenant: { equals: tenantId } }, { name: { equals: a.name } }] },
      limit: 1,
      depth: 0,
    })) as unknown as { docs: Doc[] }).docs[0];
    if (!centralAuthor) continue;
    if (!DRY_RUN) await pUpdate(payload, "authors", centralAuthor.id as number | string, { user: centralUserId });
    relinked += 1;
  }
  console.log(`[users] authors re-linked: ${relinked}`);

  if (tempPasswords.length) {
    console.log("\n[users] TEMP PASSWORDS (shown once — distribute + reset):");
    for (const [email, password] of tempPasswords) console.log(`  ${email}  ${password}`);
  }
  console.log(`[users] done (${sourceUsers.length} source users, dry-run=${DRY_RUN})`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[users] failed", err);
  process.exit(1);
});
