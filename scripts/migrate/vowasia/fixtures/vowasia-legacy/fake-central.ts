/**
 * In-memory FAKE Central for the VowAsia phase-B unit tests (no Payload, no
 * database, no network). Implements `CentralPort` with the small subset of the
 * Payload `where` language the tools use (and / equals / not_equals / like / in /
 * contains / exists). Synthetic data only (repo is PUBLIC): fake hosts, fake names.
 *
 * Behaviour mirrored from Central where the tools depend on it:
 *  - ids are integers, `createdAt` / `updatedAt` advance on every write;
 *  - an article starts at `version` 1; an update bumps it unless `systemWrite`;
 *  - a Media upload gets `prefix` = the tenant slug (the upload-integrity hook)
 *    and Payload's `-<n>` rename when the filename is taken in the bucket.
 */
import type { CentralPort, Doc, FindOptions, Id, WriteOptions } from "../../lib/vowasia-port";
import { VOWASIA_AUTHORS, VOWASIA_PILLARS, VOWASIA_SUBSECTIONS, VOWASIA_TAGS } from "../../../../lib/vowasia-taxonomy";

export interface FakeHooks {
  failCreate?: (collection: string, data: Doc) => Error | undefined;
  /** The row IS committed, then the call throws (a lost reply: connection reset/timeout after COMMIT). */
  failCreateAfterCommit?: (collection: string, data: Doc) => Error | undefined;
  failDelete?: (collection: string, id: Id) => Error | undefined;
}

type Cond = Record<string, unknown>;

function match(doc: Doc, where: Cond): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "and") {
      if (!(v as Cond[]).every((w) => match(doc, w))) return false;
      continue;
    }
    if (k === "or") {
      if (!(v as Cond[]).some((w) => match(doc, w))) return false;
      continue;
    }
    const raw = doc[k];
    const val = raw !== null && typeof raw === "object" && !Array.isArray(raw) && "id" in (raw as Doc) ? (raw as Doc).id : raw;
    for (const [op, want] of Object.entries(v as Cond)) {
      const eq = (a: unknown, b: unknown) => a !== undefined && a !== null && String(a) === String(b);
      if (op === "equals" && !eq(val, want)) return false;
      if (op === "not_equals" && eq(val, want)) return false;
      if (op === "in" && !(want as unknown[]).some((w) => eq(val, w))) return false;
      if (op === "like" && !String(val ?? "").includes(String(want))) return false;
      if (op === "contains" && !(Array.isArray(val) ? val.some((x) => eq(x, want)) : String(val ?? "").includes(String(want)))) return false;
      if (op === "exists" && (val !== undefined && val !== null) !== Boolean(want)) return false;
    }
  }
  return true;
}

export class FakeCentral implements CentralPort {
  readonly tables = new Map<string, Doc[]>();
  readonly writes: { op: "create" | "update" | "delete"; collection: string; id?: Id; data?: Doc; options?: WriteOptions }[] = [];
  private nextId = 1;
  private clock = Date.parse("2026-10-20T00:00:00.000Z");
  hooks: FakeHooks = {};

  rows(collection: string): Doc[] {
    let t = this.tables.get(collection);
    if (!t) {
      t = [];
      this.tables.set(collection, t);
    }
    return t;
  }

  now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  /** Insert a row directly (test setup; not recorded as a tool write). */
  seed(collection: string, data: Doc): Doc {
    const doc: Doc = { id: this.nextId++, createdAt: this.now(), updatedAt: this.now(), ...data };
    if (collection === "articles" && doc.version === undefined) doc.version = 1;
    this.rows(collection).push(doc);
    return doc;
  }

  async find(collection: string, where: Doc, o: FindOptions = {}): Promise<{ docs: Doc[]; hasNextPage: boolean; totalDocs: number }> {
    const all = this.rows(collection).filter((d) => match(d, where));
    if (o.sort === "id") all.sort((a, b) => Number(a.id) - Number(b.id));
    const limit = o.limit ?? 10;
    if (limit === 0) return { docs: [], hasNextPage: false, totalDocs: all.length };
    const page = o.page ?? 1;
    const docs = all.slice((page - 1) * limit, page * limit).map((d) => structuredClone(d));
    return { docs, hasNextPage: page * limit < all.length, totalDocs: all.length };
  }

  async create(collection: string, data: Doc, o: WriteOptions = {}): Promise<Doc> {
    const err = this.hooks.failCreate?.(collection, data);
    if (err) throw err;
    const doc: Doc = { ...structuredClone(data), id: this.nextId++ };
    doc.createdAt = this.now();
    doc.updatedAt = doc.createdAt;
    if (collection === "articles") doc.version = 1;
    if (collection === "media" && o.file) {
      const tenant = this.rows("tenants").find((t) => String(t.id) === String(doc.tenant));
      doc.prefix = tenant ? String(tenant.slug) : null;
      let name = o.file.name;
      const dot = name.lastIndexOf(".");
      for (let n = 1; this.rows("media").some((m) => m.filename === name); n++) name = `${o.file.name.slice(0, dot)}-${n}${o.file.name.slice(dot)}`;
      doc.filename = name;
      doc.mimeType = o.file.mimetype;
      doc.filesize = o.file.size;
    }
    this.rows(collection).push(doc);
    this.writes.push({ op: "create", collection, id: doc.id as Id, data: structuredClone(data), options: { ...o, file: o.file ? { ...o.file, data: Buffer.alloc(0) } : undefined } });
    const late = this.hooks.failCreateAfterCommit?.(collection, data);
    if (late) throw late;
    return structuredClone(doc);
  }

  async update(collection: string, id: Id, data: Doc, o: WriteOptions = {}): Promise<Doc> {
    const doc = this.rows(collection).find((d) => String(d.id) === String(id));
    if (!doc) throw new Error(`fake: ${collection} ${String(id)} not found`);
    Object.assign(doc, structuredClone(data));
    doc.updatedAt = this.now();
    if (collection === "articles" && !o.context?.systemWrite) doc.version = Number(doc.version ?? 1) + 1;
    this.writes.push({ op: "update", collection, id, data: structuredClone(data), options: o });
    return structuredClone(doc);
  }

  async delete(collection: string, id: Id, o: WriteOptions = {}): Promise<void> {
    const err = this.hooks.failDelete?.(collection, id);
    if (err) throw err;
    const t = this.rows(collection);
    const i = t.findIndex((d) => String(d.id) === String(id));
    if (i < 0) throw new Error(`fake: ${collection} ${String(id)} not found`);
    t.splice(i, 1);
    this.writes.push({ op: "delete", collection, id, options: o });
  }
}

/** A Central with tenant `vowasia` and its full taxonomy (the 49-row OB1 state), plus another tenant. */
export function seededCentral(o: { omit?: { pillar?: string; subSection?: string; tag?: string; author?: string; subUnderWrongPillar?: string } } = {}): { central: FakeCentral; tenantId: Id; otherTenantId: Id } {
  const c = new FakeCentral();
  const t = c.seed("tenants", { slug: "vowasia", name: "VowAsia" });
  const other = c.seed("tenants", { slug: "gtp", name: "Other" });
  const pillarIds = new Map<string, Id>();
  for (const p of VOWASIA_PILLARS) {
    if (o.omit?.pillar === p.slug) continue;
    pillarIds.set(p.slug, c.seed("pillars", { tenant: t.id, slug: p.slug, title: p.title }).id as Id);
  }
  for (const s of VOWASIA_SUBSECTIONS) {
    if (o.omit?.subSection === s.slug) continue;
    const pillar = o.omit?.subUnderWrongPillar === s.slug ? pillarIds.get("press-room") : pillarIds.get(s.pillarSlug);
    c.seed("subsections", { tenant: t.id, slug: s.slug, title: s.title, pillar });
  }
  for (const g of VOWASIA_TAGS) if (o.omit?.tag !== g.slug) c.seed("tags", { tenant: t.id, slug: g.slug, title: g.title });
  for (const a of VOWASIA_AUTHORS) if (o.omit?.author !== a.name) c.seed("authors", { tenant: t.id, name: a.name, slug: a.slug });
  // the other tenant has look-alike rows that must never be picked
  c.seed("pillars", { tenant: other.id, slug: "style", title: "Style" });
  c.seed("authors", { tenant: other.id, name: "Serene Chia", slug: "serene-chia" });
  return { central: c, tenantId: t.id as Id, otherTenantId: other.id as Id };
}
