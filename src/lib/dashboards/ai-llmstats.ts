/**
 * LLM Stats adapter for the `ai-weekly` cron
 * (`src/app/api/cron/refresh-ai-leaderboard/route.ts`).
 *
 * Moved here verbatim from dtw-web on 04-09-2026, when local Payload was removed
 * from the sites: the rows it refreshes now live in Central's
 * `aiLeaderboardRows`, so the job that writes them belongs next to the data. The
 * full design lives in dtw-web's
 * `process/features/dashboards/references/ai-leaderboard-llmstats-design_REFERENCE_30-07-26.md`
 * (§3 adapter design, §8 live verification addendum).
 *
 * Makes 7 request groups per run:
 *   (a) a `GET /v1/models?limit=200` page walk (follows `next_cursor` until
 *       exhausted — ~2 pages for the ~335-model catalog), indexed by `id` →
 *       `maker` (organization.name), `inputPrice`/`outputPrice` (min non-null
 *       provider price; `0` = free), `released` (release_date, written only
 *       when non-null).
 *   (b) six `GET /v1/rankings?category={general|reasoning|code|math|search|vision}&limit=50`
 *       calls → `conservative_rating` (TrueSkill μ−3σ, raw ~0-60 scale, 1
 *       decimal) indexed by `model_id`, one call per category. `code` is the
 *       canonical category id (`coding` is an accepted alias for the same
 *       data, per §8) and maps to the `coding` aiLeaderboardRows field.
 *
 * Does NOT read `top_scores` (benchmark-native mixed units — verified
 * unusable, §8) or rankings' `score` field (inconsistent scale) —
 * `conservative_rating` only.
 *
 * Never creates aiLeaderboardRows rows and never matches by anything other than exact
 * `sourceSlugLlmstats` id — that matching happens in the route handler, not
 * here. This module only fetches + shapes upstream data.
 */

const API_BASE = "https://api.llm-stats.com/stats/v1";
const MODELS_PAGE_LIMIT = 200;
const RANKINGS_LIMIT = 50;

/** LLM Stats rankings category ids this adapter reads (§8). */
const CATEGORIES = ["general", "reasoning", "code", "math", "search", "vision"] as const;
type Category = (typeof CATEGORIES)[number];

/** Rankings category id → aiModels field name ("code" → "coding"). */
const CATEGORY_FIELD = {
  general: "general",
  reasoning: "reasoning",
  code: "coding",
  math: "math",
  search: "search",
  vision: "vision",
} as const satisfies Record<Category, string>;

/**
 * One row of upstream data to reconcile against an existing `aiLeaderboardRows` doc,
 * matched by `sourceSlugLlmstats`. Every field but the id itself is optional
 * — a field is present only when this run actually observed a value for it
 * (the route handler treats "absent" as "leave whatever is already stored,"
 * same as a category a model falls outside the top-50 of).
 */
export interface AiLlmstatsRow {
  sourceSlugLlmstats: string;
  maker?: string;
  general?: number;
  reasoning?: number;
  coding?: number;
  math?: number;
  search?: number;
  vision?: number;
  inputPrice?: number;
  outputPrice?: number;
  released?: string;
}

export class LlmStatsFetchError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "LlmStatsFetchError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 300-1000ms jittered backoff before a single retry. */
function jitterMs(): number {
  return 300 + Math.floor(Math.random() * 700);
}

interface LlmStatsErrorEnvelope {
  error?: { code?: string; message?: string };
}

/**
 * Fetches one LLM Stats endpoint with the mandatory failure handling from the
 * design reference (§3, verbatim):
 *   - an HTTP 2xx response with a non-JSON body is treated as a failure
 *     (Cloudflare bot-challenge can serve HTML with a 200 status);
 *   - a genuine error response is parsed as `{ error: { code, message } }`;
 *   - HTTP 429 honors `Retry-After` before its single retry;
 *   - any other transient failure (network error, 5xx, bad-JSON 2xx) gets
 *     one retry with jittered backoff;
 *   - an unrecovered failure throws `LlmStatsFetchError` — the caller (the
 *     route handler) writes nothing on any thrown error, so last-good
 *     `aiLeaderboardRows` data keeps rendering.
 */
async function fetchLlmStats<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  attempt = 0
): Promise<T> {
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (err) {
    if (attempt === 0) {
      await sleep(jitterMs());
      return fetchLlmStats<T>(path, params, apiKey, attempt + 1);
    }
    throw new LlmStatsFetchError(
      `network error fetching ${path}: ${(err as Error).message}`
    );
  }

  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null; // non-JSON body — handled below, both for 2xx and error responses
  }

  if (!res.ok) {
    const envelope =
      body && typeof body === "object" ? (body as LlmStatsErrorEnvelope).error : undefined;
    if (res.status === 429 && attempt === 0) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : jitterMs();
      await sleep(Number.isFinite(waitMs) && waitMs > 0 ? waitMs : jitterMs());
      return fetchLlmStats<T>(path, params, apiKey, attempt + 1);
    }
    if (res.status >= 500 && attempt === 0) {
      await sleep(jitterMs());
      return fetchLlmStats<T>(path, params, apiKey, attempt + 1);
    }
    throw new LlmStatsFetchError(
      envelope?.message ?? `LLM Stats request failed (HTTP ${res.status}) for ${path}`,
      envelope?.code,
      res.status
    );
  }

  if (body === null || typeof body !== "object") {
    // 2xx but not JSON — Cloudflare challenge page, empty body, or an outage
    // that still returns 200. Treat as a failure per the design reference.
    if (attempt === 0) {
      await sleep(jitterMs());
      return fetchLlmStats<T>(path, params, apiKey, attempt + 1);
    }
    throw new LlmStatsFetchError(
      `non-JSON 2xx response from ${path} (bot challenge or outage)`
    );
  }

  return body as T;
}

interface LlmStatsProvider {
  input_price_per_m?: number | null;
  output_price_per_m?: number | null;
}

interface LlmStatsModelSummary {
  id: string;
  organization?: { name?: string | null } | null;
  providers?: LlmStatsProvider[] | null;
  release_date?: string | null;
}

interface LlmStatsModelsResponse {
  models?: LlmStatsModelSummary[];
  next_cursor?: string | null;
}

function minProviderPrice(
  providers: LlmStatsProvider[] | null | undefined,
  field: "input_price_per_m" | "output_price_per_m"
): number | undefined {
  let min: number | undefined;
  for (const p of providers ?? []) {
    const v = p[field];
    if (v != null && (min === undefined || v < min)) min = v;
  }
  return min;
}

interface CatalogEntry {
  maker?: string;
  inputPrice?: number;
  outputPrice?: number;
  released?: string;
}

/** Walks every page of `/v1/models`, indexed by upstream model id. */
async function walkModelsCatalog(apiKey: string): Promise<Map<string, CatalogEntry>> {
  const out = new Map<string, CatalogEntry>();
  let cursor: string | undefined;
  do {
    const page = await fetchLlmStats<LlmStatsModelsResponse>(
      "/models",
      { limit: MODELS_PAGE_LIMIT, cursor },
      apiKey
    );
    for (const m of page.models ?? []) {
      if (!m.id) continue;
      out.set(m.id, {
        maker: m.organization?.name ?? undefined,
        inputPrice: minProviderPrice(m.providers, "input_price_per_m"),
        outputPrice: minProviderPrice(m.providers, "output_price_per_m"),
        released: m.release_date ?? undefined,
      });
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

interface LlmStatsRankingRow {
  model_id?: string;
  conservative_rating?: number | null;
}

interface LlmStatsRankingsResponse {
  models?: LlmStatsRankingRow[];
}

/** One `/v1/rankings?category=…` call, indexed by `model_id` → `conservative_rating`. */
async function fetchCategoryRatings(
  category: Category,
  apiKey: string
): Promise<Map<string, number>> {
  const data = await fetchLlmStats<LlmStatsRankingsResponse>(
    "/rankings",
    { category, limit: RANKINGS_LIMIT },
    apiKey
  );
  const out = new Map<string, number>();
  for (const row of data.models ?? []) {
    if (row.model_id && typeof row.conservative_rating === "number") {
      out.set(row.model_id, Math.round(row.conservative_rating * 10) / 10);
    }
  }
  return out;
}

/**
 * Fetches the full LLM Stats catalog walk + all six rankings categories and
 * merges them into one row per observed upstream model id. Throws
 * `LlmStatsFetchError` (uncaught) if any of the 7 request groups ultimately
 * fails — the caller must treat that as "write nothing this run."
 */
export async function fetchAiLlmstatsUpdates(apiKey: string): Promise<AiLlmstatsRow[]> {
  const catalog = await walkModelsCatalog(apiKey);

  const ratingsByCategory = new Map<Category, Map<string, number>>();
  for (const category of CATEGORIES) {
    ratingsByCategory.set(category, await fetchCategoryRatings(category, apiKey));
  }

  const ids = new Set<string>(catalog.keys());
  for (const ratings of ratingsByCategory.values()) {
    for (const id of ratings.keys()) ids.add(id);
  }

  const rows: AiLlmstatsRow[] = [];
  for (const id of ids) {
    const entry = catalog.get(id);
    const row: AiLlmstatsRow = { sourceSlugLlmstats: id };
    if (entry?.maker) row.maker = entry.maker;
    if (entry?.inputPrice !== undefined) row.inputPrice = entry.inputPrice;
    if (entry?.outputPrice !== undefined) row.outputPrice = entry.outputPrice;
    if (entry?.released) row.released = entry.released;
    for (const category of CATEGORIES) {
      const rating = ratingsByCategory.get(category)?.get(id);
      if (rating !== undefined) {
        row[CATEGORY_FIELD[category]] = rating;
      }
    }
    rows.push(row);
  }
  return rows;
}
