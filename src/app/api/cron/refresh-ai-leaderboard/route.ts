import { getPayload } from "payload";
import config from "@payload-config";
import { json } from "@/lib/http";
import { fetchAiLlmstatsUpdates, LlmStatsFetchError } from "@/lib/dashboards/ai-llmstats";

/**
 * AI Leaderboard weekly refresh — GET /api/cron/refresh-ai-leaderboard.
 *
 * Moved here from dtw-web's `/api/dashboards/refresh/ai-weekly` on 04-09-2026,
 * when local Payload was removed from the sites. The rows live in Central now,
 * so the job that writes them does too. Runs across EVERY tenant in one pass
 * (same shape as cron/publish-scheduled and cron/unpin-expired) — matching is by
 * `sourceSlugLlmstats`, which is unique per row, so a tenant only ever sees its
 * own rows updated.
 *
 * Ownership rules carried over verbatim (AD-4/AD-5 — human always wins):
 *   - never CREATES a row; an upstream id with no matching row is logged and skipped;
 *   - never writes `rank` / `model` / `sourceSlugLlmstats` (editor-owned);
 *   - never writes a field named in that row's `editorLocked` array.
 *
 * On ANY adapter failure it writes NOTHING and returns 200 — last-good rows keep
 * rendering. A 5xx here would make Vercel retry a job whose upstream is down.
 *
 * Auth: same NODE_ENV-gated policy as the other crons.
 *   - CRON_SECRET set (any environment) -> `Authorization: Bearer <secret>` required, else 401.
 *   - CRON_SECRET unset + production    -> 503, fail CLOSED.
 *   - CRON_SECRET unset + non-production -> open, for local `curl`.
 */
export const maxDuration = 60;

/** Fields the cron owns. `rank`/`model`/`sourceSlugLlmstats` are absent on purpose. */
const CRON_FIELDS = [
  "maker",
  "general",
  "reasoning",
  "coding",
  "math",
  "search",
  "vision",
  "inputPrice",
  "outputPrice",
  "released",
] as const;

interface LeaderboardRow {
  id: number | string;
  sourceSlugLlmstats?: string | null;
  editorLocked?: { field?: string | null }[] | null;
}

async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (request.headers.get("authorization") !== `Bearer ${secret}`) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
  } else if (process.env.NODE_ENV === "production") {
    console.error(
      "[cron/refresh-ai-leaderboard] CRON_SECRET is not set in production — refusing to serve.",
    );
    return json({ ok: false, error: "server misconfigured" }, 503);
  }

  const apiKey = process.env.LLMSTATS_API_KEY;
  if (!apiKey) {
    console.error(
      "[cron/refresh-ai-leaderboard] LLMSTATS_API_KEY is not set — failing closed, no write",
    );
    return json({ ok: false, error: "LLM Stats not configured", written: 0, skipped: 0 }, 200);
  }

  let updates;
  try {
    updates = await fetchAiLlmstatsUpdates(apiKey);
  } catch (err) {
    const message = err instanceof LlmStatsFetchError ? err.message : (err as Error)?.message;
    console.error("[cron/refresh-ai-leaderboard] fetch failed — writing nothing", message);
    return json({ ok: false, error: "upstream fetch failed", written: 0, skipped: 0 }, 200);
  }

  const payload = await getPayload({ config });
  // Cross-tenant on purpose: this is a system job, not a request on behalf of a
  // tenant, and `sourceSlugLlmstats` is the join key regardless of owner.
  const existing = await payload.find({
    collection: "aiLeaderboardRows",
    limit: 0,
    depth: 0,
    overrideAccess: true,
  });
  const bySlug = new Map<string, LeaderboardRow>();
  for (const doc of existing.docs as unknown as LeaderboardRow[]) {
    if (doc.sourceSlugLlmstats) bySlug.set(doc.sourceSlugLlmstats, doc);
  }

  let written = 0;
  let skipped = 0;
  for (const update of updates) {
    const doc = bySlug.get(update.sourceSlugLlmstats);
    if (!doc) {
      skipped++;
      continue;
    }

    const locked = new Set((doc.editorLocked ?? []).map((l) => l.field).filter(Boolean));
    const data: Record<string, unknown> = {};
    for (const field of CRON_FIELDS) {
      if (locked.has(field)) continue;
      const value = (update as unknown as Record<string, unknown>)[field];
      if (value !== undefined) data[field] = value;
    }
    if (Object.keys(data).length === 0) continue; // nothing owned+unlocked to write
    if (!locked.has("asOfScores")) data.asOfScores = new Date().toISOString();

    await payload.update({
      collection: "aiLeaderboardRows",
      id: doc.id,
      data: data as never,
      overrideAccess: true,
    });
    written++;
  }

  console.log(
    `[cron/refresh-ai-leaderboard] ${written} row(s) updated, ${skipped} upstream id(s) unmatched (logged, skipped)`,
  );
  return json({ ok: true, written, skipped }, 200);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

/** POST is the manual/ops entry point — same handler, same auth (AD-8). */
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
