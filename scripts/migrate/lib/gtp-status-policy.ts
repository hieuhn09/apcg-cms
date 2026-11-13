/**
 * GTP published-only policy (owner decision 10-11-26, supersedes OD-8).
 *
 * Old-site ARCHIVED and DRAFT articles are dropped: not imported into Central,
 * no redirect (their old URLs simply 404). Only PUBLISHED legacy rows (and
 * active events) are migrated. Applies to the gtp tenant only; the network
 * bundle tenants (aer, agr, amb, asn) keep their mapping-driven behaviour.
 * `--include-archived-drafts` on the importer restores the old behaviour.
 * Pure: no I/O.
 */
import type { StatusDecision } from "./gtp-transform";

/** Legacy statuses the published-only policy drops. */
export const DROPPED_STATUSES: readonly string[] = Object.freeze(["archived", "draft"]);

/** The import decision after the published-only policy. `publishedOnly=false` returns `sd` unchanged. */
export function applyPublishedOnly(sd: StatusDecision, publishedOnly: boolean): StatusDecision {
  if (!publishedOnly || sd.kind !== "import" || sd.status === "published") return sd;
  return { kind: "skip", reason: `status ${sd.status} (published-only)` };
}

/** Events: an inactive legacy event maps to archived and is dropped under the policy. */
export function keepEventStatus(status: string, publishedOnly: boolean): boolean {
  return !publishedOnly || status === "published";
}

const ROLLBACK_STATUSES = new Set(["archived", "draft", "hidden", "published"]);

/** Parse `--only-status a,b`. undefined = no filter. Throws on an empty or unknown value. */
export function parseOnlyStatus(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined;
  const set = new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (!set.size) throw new Error("--only-status needs at least one status (e.g. archived,draft).");
  for (const s of set) if (!ROLLBACK_STATUSES.has(s)) throw new Error(`--only-status: unknown status "${s}" (allowed: ${[...ROLLBACK_STATUSES].join(", ")}).`);
  return set;
}

/**
 * Rollback status filter. A journaled row is selected only when BOTH the status the
 * importer recorded in the run's slug map (the mapped legacy status) AND the Central
 * row's current `workflowStatus` are in `only`. A row an editor has since published
 * is therefore never selected by `--only-status archived,draft`. No filter = all rows.
 */
export function matchesOnlyStatus(entryStatus: string, docWorkflowStatus: unknown, only: Set<string> | undefined): boolean {
  if (!only) return true;
  const e = String(entryStatus ?? "").toLowerCase().replace(/^event:/, "");
  const d = String(docWorkflowStatus ?? "").toLowerCase();
  return only.has(e) && only.has(d);
}
