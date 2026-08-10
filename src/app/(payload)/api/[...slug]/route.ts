import config from "@payload-config";
import {
  REST_DELETE,
  REST_GET,
  REST_OPTIONS,
  REST_PATCH,
  REST_POST,
  REST_PUT,
} from "@payloadcms/next/routes";

const payloadGet = REST_GET(config);

/**
 * Media file bytes get a CDN cache header; everything else passes through.
 *
 * Payload serves `/api/media/file/<name>` by streaming the object from R2
 * through this function with `Cache-Control: max-age=0, must-revalidate`, so
 * Vercel's edge re-invoked the function for EVERY image request from every
 * reader — the bytes were billed as fast origin transfer on each page view
 * (verified live: `x-vercel-cache: MISS` on repeat fetches). One day of
 * s-maxage plus a week of stale-while-revalidate lets the edge serve repeats
 * itself; a replaced image can lag up to a day, acceptable for hero art
 * (Payload dedupes filenames on upload, so same-name overwrites are rare).
 *
 * Media bytes are public (Media collection read access is `() => true`) and
 * the URL carries the tenant prefix, so shared edge caching leaks nothing.
 * The JSON API (`/api/public/*`) is deliberately NOT cached here: those
 * responses vary on the Authorization read token, and a shared cache keyed
 * only by URL could serve one tenant's payload to another.
 */
export const GET = async (
  ...args: Parameters<typeof payloadGet>
): Promise<Response> => {
  const res = await payloadGet(...args);
  const { pathname } = new URL(args[0].url);
  if (res.status === 200 && pathname.startsWith("/api/media/file/")) {
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  return res;
};

export const POST = REST_POST(config);
export const DELETE = REST_DELETE(config);
export const PATCH = REST_PATCH(config);
export const PUT = REST_PUT(config);
export const OPTIONS = REST_OPTIONS(config);
