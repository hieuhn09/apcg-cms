import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPublishedOnly, keepEventStatus, matchesOnlyStatus, parseOnlyStatus } from "./gtp-status-policy";
import { mapStatus } from "./gtp-transform";
import { expectedFromSource } from "./gtp-expected";

const M = { status: { map: { published: "published", archived: "archived", draft: "draft", rejected: "SKIP" }, unknown: "reject" as const } };

test("published-only: archived and draft are skipped with a counted reason; published imports; rejects untouched", () => {
  const d = (s: string) => applyPublishedOnly(mapStatus(s, M as never), true);
  assert.deepEqual(d("published"), { kind: "import", status: "published" });
  assert.deepEqual(d("archived"), { kind: "skip", reason: "status archived (published-only)" });
  assert.deepEqual(d("Draft"), { kind: "skip", reason: "status draft (published-only)" });
  assert.equal(d("rejected").kind, "skip");
  assert.equal(d("deleted").kind, "reject");
});

test("--include-archived-drafts (publishedOnly=false) keeps the old behaviour", () => {
  assert.deepEqual(applyPublishedOnly(mapStatus("archived", M as never), false), { kind: "import", status: "archived" });
  assert.deepEqual(applyPublishedOnly(mapStatus("draft", M as never), false), { kind: "import", status: "draft" });
  assert.equal(keepEventStatus("archived", false), true);
});

test("events: inactive (archived) dropped under published-only", () => {
  assert.equal(keepEventStatus("published", true), true);
  assert.equal(keepEventStatus("archived", true), false);
});

test("parseOnlyStatus: list, case, unknown and empty values", () => {
  assert.equal(parseOnlyStatus(undefined), undefined);
  assert.deepEqual([...(parseOnlyStatus(" Archived,draft ") as Set<string>)], ["archived", "draft"]);
  assert.throws(() => parseOnlyStatus(""), /at least one/);
  assert.throws(() => parseOnlyStatus("archived,gone"), /unknown status "gone"/);
});

test("rollback status filter: needs BOTH the journal status and the Central workflowStatus in the list", () => {
  const only = parseOnlyStatus("archived,draft");
  assert.equal(matchesOnlyStatus("archived", "archived", only), true);
  assert.equal(matchesOnlyStatus("draft", "draft", only), true);
  assert.equal(matchesOnlyStatus("event:archived", "archived", only), true);
  assert.equal(matchesOnlyStatus("published", "published", only), false);
  assert.equal(matchesOnlyStatus("archived", "published", only), false, "an editor republished it: never deleted");
  assert.equal(matchesOnlyStatus("published", "archived", only), false, "hidden by an editor after a published import: not this filter");
  assert.equal(matchesOnlyStatus("published", "published", undefined), true, "no filter = full rollback");
});

test("verify expectation: published-only counts archived/draft as absent", () => {
  const m = { ...M, categories: { map: {}, fallback: null, unmapped: "reject" } } as never;
  const rows = [
    { id: "1", status: "published", section: "news", subsection: "" },
    { id: "2", status: "archived", section: "news", subsection: "" },
    { id: "3", status: "draft", section: "news", subsection: "" },
  ];
  const po = expectedFromSource(rows, m, { publishedOnly: true });
  assert.deepEqual(po.byStatus, { published: 1 });
  assert.deepEqual(po.rejected.sort(), ["2", "3"]);
  assert.deepEqual(expectedFromSource(rows, m).byStatus, { published: 1, archived: 1, draft: 1 });
});
