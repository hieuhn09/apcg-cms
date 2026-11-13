/**
 * POST /api/hub/media/register?tenant=<slug> — turn ONE object the browser PUT into
 * R2 staging (via /api/hub/media/sign) into a tenant `media` document (hub docx import,
 * phase A). Body EXACTLY {uploadId, alt, caption?, credit?, actorRole, actorId?}
 * (≤ 4,096 bytes). Re-checks everything after the upload (HEAD, capped read, magic
 * bytes, header size, pixel cap, re-encode), deterministic file name, dedup.
 * 201 created / 200 `deduped:true`. OFF unless env HUB_DIRECT_UPLOAD_TENANTS lists the
 * tenant. Everything lives in src/lib/hub-direct-upload-core.ts. Internal route: no CORS.
 */

import { handleHubMediaRegister } from "@/lib/hub-direct-upload-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Plan default. Spike A2 (content-engine report hub-docx-ai-import-pa_REPORT_28-10-26.md): p95 ≤ 9.3 s at 12 MP on a dev machine. */
export const maxDuration = 60;

export const POST = (request: Request) => handleHubMediaRegister(request);
