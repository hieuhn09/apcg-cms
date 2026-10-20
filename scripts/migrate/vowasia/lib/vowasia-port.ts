/**
 * The narrow Central interface every VowAsia phase-B tool talks to (import,
 * rollback, rewrite-links, redirects, verify). The real implementation wraps the
 * Payload Local API (`vowasia-payload-port.ts`, loaded only by the CLI entry
 * files); unit tests pass an in-memory fake (`fixtures/vowasia-legacy/fake-central.ts`),
 * so no test boots Payload or a database.
 *
 * Every write carries `WRITE_CTX` (no revalidate webhook, no translation
 * enqueue, E3); rewrite-links adds `systemWrite` (no version bump).
 */
export type Id = number | string;
export type Doc = Record<string, unknown>;

export interface FindOptions {
  draft?: boolean;
  limit?: number;
  page?: number;
  sort?: string;
}

export interface UploadFile {
  data: Buffer;
  mimetype: string;
  name: string;
  size: number;
}

export interface WriteOptions {
  draft?: boolean;
  file?: UploadFile;
  context?: Record<string, unknown>;
}

export interface CentralPort {
  find(collection: string, where: Doc, o?: FindOptions): Promise<{ docs: Doc[]; hasNextPage: boolean; totalDocs?: number }>;
  create(collection: string, data: Doc, o?: WriteOptions): Promise<Doc>;
  update(collection: string, id: Id, data: Doc, o?: WriteOptions): Promise<Doc>;
  delete(collection: string, id: Id, o?: WriteOptions): Promise<void>;
  close?(): Promise<void>;
}

export const WRITE_CTX = Object.freeze({ disableRevalidate: true, skipTranslationEnqueue: true });
export const SYSTEM_WRITE_CTX = Object.freeze({ ...WRITE_CTX, systemWrite: true });

/** Every doc of a query, page by page until exhausted. */
export async function findAll(port: CentralPort, collection: string, where: Doc, o: Omit<FindOptions, "page" | "limit"> = {}): Promise<Doc[]> {
  const out: Doc[] = [];
  for (let page = 1; ; page++) {
    const r = await port.find(collection, where, { ...o, limit: 200, page });
    out.push(...r.docs);
    if (!r.hasNextPage || r.docs.length === 0) return out;
  }
}

export async function findOne(port: CentralPort, collection: string, where: Doc, draft = false): Promise<Doc | undefined> {
  return (await port.find(collection, where, { limit: 1, ...(draft ? { draft: true } : {}) })).docs[0];
}

/** Relationship value -> id string (depth 0 id or populated doc). */
export function relId(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "object") return String((v as Doc).id);
  return String(v);
}
