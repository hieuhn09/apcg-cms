/**
 * Single-home pillar enforcement for Articles + SubSections (rule source:
 * src/lib/single-home-pillars.ts).
 *
 * `singleHomePillar` — Articles `beforeChange`, registered BEFORE
 * articleBookkeeping. Collection beforeChange runs on EVERY write path (admin
 * incl. Save Draft, REST, GraphQL, Local API, Console, engine intake, scripts);
 * field `validate` is skipped on drafts, so this hook is the real boundary.
 *
 * D-A (effective state): on `operation === 'update'` an absent key is the STORED
 * value (`data[k] !== undefined ? data[k] : originalDoc[k]`), never "empty".
 * Payload usually backfills absent keys before this hook, but NOT under
 * `req.context.isRestoringVersion` — which a GraphQL request shares across its
 * mutation fields (restoreVersionX + updateX in one request) — so the hook never
 * relies on that backfill. Keyed on `operation`, never on `originalDoc`
 * presence (create passes `{}`, duplicate passes the source doc). If the
 * normalised taxonomy is unchanged and `exclusive` did not flip to true, the
 * write returns immediately with NO lookups (status-only writers: hub, cron,
 * translation write-backs). `req.context` skip flags are deliberately ignored.
 *
 * D-B: lookups FAIL CLOSED (no catch) in the hook and validators; only the
 * admin `filterOptions` fails open (exactly `true`).
 */
import type { CollectionBeforeChangeHook, PayloadRequest } from "payload";
import { ValidationError } from "payload";
import { relationship } from "payload/shared";
import {
  checkSingleHome,
  humanErrorMessage,
  idKey,
  normalizeTaxonomy,
  pillarFilterWhere,
  resolveSingleHome,
  resolveTenantSlugs,
  secondaryRowPillarDecision,
  singleHomeSlugUnion,
  singleHomeSlugsFor,
  subSectionPillarDecision,
  taxonomyChanged,
  type FindFn,
  type Taxonomy,
} from "@/lib/single-home-pillars";

/** Injected batched `find` bound to the request (transaction + memo context). */
export function findFor(req: PayloadRequest): FindFn {
  return (args) =>
    req.payload.find({ ...args, req } as never) as unknown as Promise<{ docs: Array<Record<string, unknown>> }>;
}

function contextOf(req: PayloadRequest): Record<string, unknown> | undefined {
  return req.context as Record<string, unknown> | undefined;
}

/** Field path named in a malformed-input error, e.g. "(secondarySections.0.pillar)". */
function malformedPath(err: unknown): string {
  const m = /\(([^()]+)\)\.$/.exec(humanErrorMessage(err));
  return m?.[1] ?? "secondarySections";
}

export const singleHomePillar: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req, collection }) => {
  if (!data) return data;
  const isUpdate = operation === "update";
  const orig: Record<string, unknown> =
    isUpdate && originalDoc !== null && typeof originalDoc === "object" ? (originalDoc as Record<string, unknown>) : {};
  const eff = (k: string): unknown => (isUpdate && data[k] === undefined ? orig[k] : data[k]);

  let next: Taxonomy;
  let prev: Taxonomy | null = null;
  try {
    next = normalizeTaxonomy({ pillar: eff("pillar"), subSection: eff("subSection"), secondarySections: eff("secondarySections") });
    if (isUpdate) {
      prev = normalizeTaxonomy({ pillar: orig.pillar, subSection: orig.subSection, secondarySections: orig.secondarySections });
    }
  } catch (err) {
    throw new ValidationError(
      { collection: collection.slug, errors: [{ message: humanErrorMessage(err), path: malformedPath(err) }], req },
      req.t,
    );
  }

  const exclusive = eff("exclusive") === true;
  if (prev) {
    // V6 (G79a): only a flip TO true re-opens evaluation.
    const exclusiveFlippedOn = exclusive && orig.exclusive !== true;
    if (!taxonomyChanged(next, prev) && !exclusiveFlippedOn) return data;
  }

  const ids = [next.pillar, ...next.secondary.map((r) => r.pillar)].filter((k): k is string => k !== null);
  const singleHome = await resolveSingleHome({ pillarIds: ids, find: findFor(req), context: contextOf(req) });
  const violation = checkSingleHome(next, (k) => (k === null ? null : (singleHome.get(k) ?? null)), exclusive);
  if (violation) {
    throw new ValidationError({ collection: collection.slug, errors: [violation], req }, req.t);
  }
  return data;
};

// ── Field validators (non-draft saves only) ─────────────────────────────────

type RelationshipValidate = typeof relationship;
type RelValue = Parameters<RelationshipValidate>[0];
type RelOptions = Parameters<RelationshipValidate>[1];

/**
 * Articles `secondarySections[].pillar` validate (V3). A custom `validate`
 * REPLACES Payload's default, so the base `relationship` validator runs first.
 *
 * An UNCHANGED row (previousValue is ID-matched by row id, and defined) returns
 * `true` WITHOUT calling `relationship()`: that re-runs `filterOptions`, which
 * would reject a pre-existing Pressroom row and block status-only writers (hub
 * hide/republish, cron) on a legacy article. Any other row (incl. a row sent
 * without an id) is evaluated, with `filterOptions` stripped so Payload's own
 * re-check cannot reject on UX grounds.
 */
export function makeSecondaryRowPillarValidate(base: RelationshipValidate = relationship) {
  return async (value: unknown, options: RelOptions): Promise<string | true> => {
    const v = value as RelValue;
    if (options.previousValue !== undefined && idKey(v) === idKey(options.previousValue)) return true;
    const baseResult = await base(v, { ...options, filterOptions: undefined });
    if (baseResult !== true) return baseResult;
    const key = idKey(v);
    if (key === null) return true;
    const singleHome = await resolveSingleHome({ pillarIds: [key], find: findFor(options.req), context: contextOf(options.req) });
    return secondaryRowPillarDecision(singleHome.get(key) ?? null);
  };
}

export const secondaryRowPillarValidate = makeSecondaryRowPillarValidate();

/** SubSections `pillar` validate (V4): base relationship validator first, then the rule. */
export function makeSubSectionPillarValidate(base: RelationshipValidate = relationship) {
  return async (value: RelValue, options: RelOptions): Promise<string | true> => {
    const baseResult = await base(value, options);
    if (baseResult !== true) return baseResult;
    const key = idKey(value);
    if (key === null) return true;
    const singleHome = await resolveSingleHome({ pillarIds: [key], find: findFor(options.req), context: contextOf(options.req) });
    return subSectionPillarDecision(singleHome.get(key) ?? null);
  };
}

export const subSectionPillarValidate = makeSubSectionPillarValidate();

/**
 * Articles `author` validate. The field is `required: false` in the schema;
 * this restores the stock requirement (base `relationship` with
 * `required: true`, so the message is Payload's own) for every article whose
 * effective primary pillar is NOT single-home. A single-home (Pressroom)
 * article may have no author. Fails CLOSED: an unknown pillar or a lookup
 * error means the author is required. Field validate is skipped on drafts,
 * exactly as the stock `required` was.
 */
export function makeArticleAuthorValidate(base: RelationshipValidate = relationship) {
  return async (value: RelValue, options: RelOptions): Promise<string | true> => {
    const required = (): Promise<string | true> | string | true => base(value, { ...options, required: true });
    const o = options as unknown as {
      siblingData?: Record<string, unknown>;
      data?: Record<string, unknown>;
      originalDoc?: Record<string, unknown>;
    };
    const pillar = o.siblingData?.pillar ?? o.data?.pillar ?? o.originalDoc?.pillar;
    let singleHome = false;
    try {
      const key = idKey(pillar);
      if (key !== null) {
        const m = await resolveSingleHome({ pillarIds: [key], find: findFor(options.req), context: contextOf(options.req) });
        singleHome = (m.get(key) ?? null) !== null;
      }
    } catch {
      singleHome = false;
    }
    if (!singleHome) return required();
    return base(value, { ...options, required: false });
  };
}

export const articleAuthorValidate = makeArticleAuthorValidate();

/**
 * Articles `secondarySections[].pillar` filterOptions — UX ONLY, never throws:
 * exactly `true` for an unconfigured / unresolvable tenant or any lookup error;
 * `false` when the primary is single-home; else hide the single-home slugs.
 */
export const secondaryPillarFilterOptions = async ({
  data,
  req,
}: {
  data?: Record<string, unknown>;
  req: PayloadRequest;
}): Promise<true | false | { slug: { not_in: string[] } }> => {
  try {
    if (singleHomeSlugUnion().length === 0) return true;
    const tenantKey = idKey(data?.tenant);
    if (tenantKey === null) return true;
    const find = findFor(req);
    const tenants = await resolveTenantSlugs({ tenantIds: [tenantKey], find, context: contextOf(req) });
    const slugs = singleHomeSlugsFor(tenants.get(tenantKey));
    if (slugs.length === 0) return true;
    const primary = idKey(data?.pillar);
    let primaryIsSingleHome = false;
    if (primary !== null) {
      const m = await resolveSingleHome({ pillarIds: [primary], find, context: contextOf(req) });
      primaryIsSingleHome = (m.get(primary) ?? null) !== null;
    }
    return pillarFilterWhere(slugs, primaryIsSingleHome);
  } catch {
    return true;
  }
};
