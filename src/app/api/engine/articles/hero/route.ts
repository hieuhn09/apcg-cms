/**
 * POST /api/engine/articles/hero — engine hero replace (media-gtp-vowasia phase 5).
 * Thin binding only: the logic and the contract live in `src/lib/engine-hero-replace-core.ts`
 * and `docs/08-content-engine-integration.md` §Hero replace. Default OFF: every tenant answers
 * 403 `feature_disabled` until `ENGINE_HERO_REPLACE_TENANTS` lists it.
 */
import { getPayload } from "payload";
import config from "@payload-config";
import { withHubArticleLock } from "@/lib/hub-article-lock";
import { defaultLockRow, readMainAll } from "@/lib/hub-author-live-core";
import { handleHeroReplace } from "@/lib/engine-hero-replace-core";

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleHeroReplace(request, {
    getPayload: () => getPayload({ config }),
    lock: withHubArticleLock,
    lockRow: defaultLockRow,
    readMainAll: (payload, id, req) => readMainAll(payload, id, req),
  });
}
