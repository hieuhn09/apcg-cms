/**
 * POST /api/hub/media/sign?tenant=<slug> — hand the hub a 300-second presigned PUT
 * into R2 STAGING for ONE image of a hub-authored draft (hub docx import, phase A).
 * Body EXACTLY {articleId, mime, size, actorRole, actorId?} (≤ 4,096 bytes).
 * 200 = {ok, uploadId, put:{url, method, headers, expiresInSec}, limits, expiresAt}.
 * Writes nothing. OFF unless env HUB_DIRECT_UPLOAD_TENANTS lists the tenant.
 * Everything lives in src/lib/hub-direct-upload-core.ts. Internal route: no CORS.
 */

import { handleHubMediaSign } from "@/lib/hub-direct-upload-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export const POST = (request: Request) => handleHubMediaSign(request);
