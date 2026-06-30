/**
 * Console WRITE + content-read layer via the Payload Local API. Every call passes
 * the authenticated `user` with `overrideAccess: false`, so Payload's collection
 * access control, hooks (workflow/versioning/revalidate/translation-enqueue) and
 * field localization run exactly as they do in /admin.
 *
 * This module is the future "strangler seam": swapping these implementations for
 * direct Drizzle writes later would not change any calling UI code.
 */
import "server-only";
import type { CollectionSlug, Where } from "payload";
import { getPayloadClient, type CmsUser } from "../auth";

type Doc = Record<string, unknown> & { id: number | string };

interface ListOpts {
  where?: Where;
  limit?: number;
  page?: number;
  sort?: string;
  depth?: number;
  locale?: string;
}

export async function listDocs(
  collection: CollectionSlug,
  user: CmsUser,
  opts: ListOpts = {},
): Promise<{ docs: Doc[]; totalDocs: number; totalPages: number; page: number; hasNextPage: boolean }> {
  const payload = await getPayloadClient();
  const res = await payload.find({
    collection,
    overrideAccess: false,
    user: user as never,
    where: opts.where,
    limit: opts.limit ?? 50,
    page: opts.page ?? 1,
    sort: opts.sort,
    depth: opts.depth ?? 0,
    locale: (opts.locale as never) ?? undefined,
  });
  return {
    docs: res.docs as unknown as Doc[],
    totalDocs: res.totalDocs,
    totalPages: res.totalPages,
    page: res.page ?? 1,
    hasNextPage: res.hasNextPage,
  };
}

export async function getDoc(
  collection: CollectionSlug,
  id: number | string,
  user: CmsUser,
  opts: { depth?: number; locale?: string } = {},
): Promise<Doc | null> {
  const payload = await getPayloadClient();
  try {
    const doc = await payload.findByID({
      collection,
      id,
      overrideAccess: false,
      user: user as never,
      depth: opts.depth ?? 1,
      locale: (opts.locale as never) ?? undefined,
    });
    return doc as unknown as Doc;
  } catch {
    return null;
  }
}

export async function createDoc(
  collection: CollectionSlug,
  data: Record<string, unknown>,
  user: CmsUser,
  opts: { locale?: string } = {},
): Promise<Doc> {
  const payload = await getPayloadClient();
  const doc = await payload.create({
    collection,
    data: data as never,
    overrideAccess: false,
    user: user as never,
    locale: (opts.locale as never) ?? undefined,
  });
  return doc as unknown as Doc;
}

export async function updateDoc(
  collection: CollectionSlug,
  id: number | string,
  data: Record<string, unknown>,
  user: CmsUser,
  opts: { locale?: string } = {},
): Promise<Doc> {
  const payload = await getPayloadClient();
  const doc = await payload.update({
    collection,
    id,
    data: data as never,
    overrideAccess: false,
    user: user as never,
    locale: (opts.locale as never) ?? undefined,
  });
  return doc as unknown as Doc;
}

export async function deleteDoc(
  collection: CollectionSlug,
  id: number | string,
  user: CmsUser,
): Promise<void> {
  const payload = await getPayloadClient();
  await payload.delete({ collection, id, overrideAccess: false, user: user as never });
}
