/**
 * Unit tests for ./hub-author-live-pure (APCGHub P5.4). Node's built-in runner, no DB,
 * no `@payload-config` (loads with an empty environment).
 *
 *   npm run test:hub-live
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

import {
  DERIVED_LIVE_FIELD_KEYS,
  HUB_LIVE_FIELD_KEYS,
  liveDiffKeys,
  liveEditTenants,
  liveGateReason,
  livePostWriteCheck,
  liveValueEqual,
  parseLiveBody,
} from "./hub-author-live-pure";

type Doc = Record<string, unknown>;

const MAIN: Doc = { id: 7, origin: "manual", workflowStatus: "published", _status: "published", version: 4, engineDraftId: null, tenant: 1 };
const LATEST: Doc = { ...MAIN };
const gate = (main: Doc | null, latest: Doc | null, isHubAuthored = true) => liveGateReason({ main, latest, isHubAuthored });

const ACTOR = { email: "ed@example.invalid", role: "editor" };
const body = (fields: unknown, extra: Doc = {}) => ({ tenant: "gcv", expectedVersion: 4, actor: ACTOR, fields, ...extra });

test("live gate rejects when latest version differs from main with draft_diverged", () => {
  assert.equal(gate(MAIN, LATEST), null);
  assert.equal(gate(MAIN, { ...LATEST, version: 5 }), "draft_diverged");
  assert.equal(gate(MAIN, { ...LATEST, _status: "draft" }), "draft_diverged");
  assert.equal(gate(MAIN, { ...LATEST, _status: "draft", version: 5, workflowStatus: "draft" }), "draft_diverged");
  assert.equal(gate(MAIN, null), "draft_diverged");
  // draft_diverged wins over not_hub_authored (the order of D2)
  assert.equal(gate(MAIN, { ...LATEST, version: 5 }, false), "draft_diverged");
});

test("live gate rejects scheduled, hidden, archived, never-published draft, engine and CMS-hand-made articles", () => {
  assert.equal(gate({ ...MAIN, workflowStatus: "scheduled", _status: "draft" }, LATEST), "scheduled");
  assert.equal(gate(MAIN, { ...LATEST, workflowStatus: "scheduled", _status: "draft" }), "scheduled");
  assert.equal(gate({ ...MAIN, workflowStatus: "hidden" }, LATEST), "status");
  assert.equal(gate({ ...MAIN, workflowStatus: "archived" }, LATEST), "status");
  assert.equal(gate({ ...MAIN, workflowStatus: "draft", _status: "draft" }, { ...LATEST, workflowStatus: "draft", _status: "draft" }), "status");
  // workflowStatus published but Payload _status draft (an import row) ⇒ status
  assert.equal(gate({ ...MAIN, _status: "draft" }, LATEST), "status");
  assert.equal(gate({ ...MAIN, origin: "engine" }, LATEST), "origin");
  assert.equal(gate({ ...MAIN, origin: "import" }, LATEST), "origin");
  assert.equal(gate(null, LATEST), "origin");
  assert.equal(gate(MAIN, LATEST, false), "not_hub_authored"); // CMS hand-made (lastEngine null)
  assert.equal(gate({ ...MAIN, engineDraftId: "eng-1" }, LATEST), "not_hub_authored");
});

test("live body with slug key is rejected with slug_locked", () => {
  const locked = { ok: false, status: 422, body: { ok: false, status: "not_live_editable", reason: "slug_locked" } };
  assert.deepEqual(parseLiveBody(body({ slug: "new-slug" })), locked);
  assert.deepEqual(parseLiveBody(body({ slug: "same-as-stored", title: "T" })), locked);
  assert.deepEqual(parseLiveBody(body({ heroImageId: 3 })), { ok: false, status: 422, body: { ok: false, status: "not_live_editable", reason: "media_locked" } });
  assert.deepEqual(parseLiveBody(body({ leadImageCaption: null })), { ok: false, status: 422, body: { ok: false, status: "not_live_editable", reason: "media_locked" } });
  // slug wins over the media / flags locks
  assert.deepEqual(parseLiveBody(body({ heroImageId: 3, slug: "x", flags: { breaking: true } })), locked);
});

test("post-write full-field diff detects a slipped draft on a translation tenant where the version leg cannot", () => {
  const pre: Doc = {
    id: 9, title: { en: "Old", fr: "Ancien" }, dek: { en: "d" }, body: { en: { root: { type: "root", children: [] } }, fr: null },
    tags: [1, 2], pillar: 3, sponsor: null, version: 10, _status: "published", workflowStatus: "published", publishedAt: "2026-10-01T00:00:00.000Z", updatedAt: "a",
  };
  const latest = (v: number) => ({ _status: "published", version: v });
  // The live write changed `dek` (en) only; translations active, the nested update made version N+2.
  const postOk: Doc = { ...pre, dek: { en: "new dek" }, version: 12, updatedAt: "b" };
  assert.deepEqual(livePostWriteCheck({ pre, post: postOk, latest: latest(12), changedColumns: ["dek"], currentVersion: 10, translationsActive: true }), { ok: true });
  // CMS4-1 main case: a slipped non-draft write changed `title` (outside `changed`), _status still
  // published, version >= N+1 and = latest ⇒ ONLY the field leg sees it.
  const slipped: Doc = { ...postOk, title: { en: "Slipped draft title", fr: "Ancien" } };
  assert.deepEqual(livePostWriteCheck({ pre, post: slipped, latest: latest(12), changedColumns: ["dek"], currentVersion: 10, translationsActive: true }), { ok: false, leg: "fields", detail: ["title.en"] });
  // ADV3-1: the slipped write changed ONLY the fr title ⇒ caught (locale "all").
  const slippedFr: Doc = { ...postOk, title: { en: "Old", fr: "Glissé" } };
  assert.equal(livePostWriteCheck({ pre, post: slippedFr, latest: latest(12), changedColumns: ["dek"], currentVersion: 10, translationsActive: true }).ok, false);
  // A changed localized column is still compared on the OTHER locales.
  const titleEdit: Doc = { ...postOk, title: { en: "New", fr: "Ancien" } };
  assert.deepEqual(livePostWriteCheck({ pre, post: titleEdit, latest: latest(12), changedColumns: ["title", "dek"], currentVersion: 10, translationsActive: true }), { ok: true });
  assert.equal(livePostWriteCheck({ pre, post: { ...titleEdit, title: { en: "New", fr: "Autre" } }, latest: latest(12), changedColumns: ["title", "dek"], currentVersion: 10, translationsActive: true }).ok, false);
  // CMS4-2: a locale with body null on BOTH sides is equal (no false 409).
  assert.deepEqual(liveDiffKeys({ body: { en: null, fr: null } }, { body: { en: null, fr: null } }, []), []);
  assert.equal(liveValueEqual(null, undefined), true);
  assert.equal(liveValueEqual(null, { root: { type: "root" } }), false);
  // Status leg and the non-translation version leg.
  assert.deepEqual(livePostWriteCheck({ pre, post: { ...postOk, _status: "draft", version: 11 }, latest: latest(11), changedColumns: ["dek"], currentVersion: 10, translationsActive: false }), { ok: false, leg: "status", detail: ["_status"] });
  assert.equal(livePostWriteCheck({ pre, post: { ...postOk, version: 12 }, latest: latest(12), changedColumns: ["dek"], currentVersion: 10, translationsActive: false }).ok, false);
  assert.deepEqual(livePostWriteCheck({ pre, post: { ...postOk, version: 11 }, latest: latest(11), changedColumns: ["dek"], currentVersion: 10, translationsActive: false }), { ok: true });
  // A Hide that slipped in (workflowStatus archived kept by base-merge) ⇒ caught already by the field leg
  // (workflowStatus is compared there; only _status / publishedAt are left to the status leg).
  assert.deepEqual(livePostWriteCheck({ pre, post: { ...postOk, workflowStatus: "archived", version: 11 }, latest: latest(11), changedColumns: ["dek"], currentVersion: 10, translationsActive: false }), { ok: false, leg: "fields", detail: ["workflowStatus"] });
  // publishedAt moved ⇒ status leg (publishedAt is ignored by the field leg).
  assert.deepEqual(livePostWriteCheck({ pre, post: { ...postOk, publishedAt: "2026-10-02T00:00:00.000Z", version: 11 }, latest: latest(11), changedColumns: ["dek"], currentVersion: 10, translationsActive: false }), { ok: false, leg: "status", detail: ["publishedAt"] });
  // latest is a draft (Save-Draft after the write) ⇒ status leg.
  assert.deepEqual(livePostWriteCheck({ pre, post: { ...postOk, version: 11 }, latest: { _status: "draft", version: 12 }, changedColumns: ["dek"], currentVersion: 10, translationsActive: false }), { ok: false, leg: "status", detail: ["latest._status"] });
});

test("post scheduled then published by the cron is live-editable", () => {
  // The cron writes _status / workflowStatus / publishedAt only; scheduledFor stays set.
  const cronPublished = { ...MAIN, scheduledFor: "2026-10-01T10:00:00.000Z", publishedAt: "2026-10-01T10:00:00.000Z" };
  assert.equal(gate(cronPublished, { ...cronPublished }), null);
});

test("liveEditTenants matches exact CMS slugs only across the eight env vectors", () => {
  const ok = (raw: string | undefined) => {
    const env: Record<string, string | undefined> = raw === undefined ? {} : { HUB_LIVE_EDIT_TENANTS: raw };
    return liveEditTenants(env).includes("world-travel-brief");
  };
  assert.equal(ok(undefined), false);
  assert.equal(ok(""), false);
  assert.equal(ok(" "), false);
  assert.equal(ok("wtb"), false);
  assert.equal(ok("*"), false);
  assert.equal(ok("WORLD-TRAVEL-BRIEF"), false);
  assert.equal(ok("gcv,,world-travel-brief"), true);
  assert.equal(ok("world-travel-brief ,gcv"), true);
  assert.deepEqual(liveEditTenants({ HUB_LIVE_EDIT_TENANTS: "gcv,,world-travel-brief" }), ["gcv", "world-travel-brief"]);
  assert.deepEqual(liveEditTenants({ HUB_LIVE_EDIT_TENANTS: "a b,gcv" }), ["a b", "gcv"]);
  // Read on every call (no cache).
  const prev = process.env.HUB_LIVE_EDIT_TENANTS;
  try {
    process.env.HUB_LIVE_EDIT_TENANTS = "gcv";
    assert.deepEqual(liveEditTenants(), ["gcv"]);
    process.env.HUB_LIVE_EDIT_TENANTS = "dtw";
    assert.deepEqual(liveEditTenants(), ["dtw"]);
  } finally {
    if (prev === undefined) delete process.env.HUB_LIVE_EDIT_TENANTS;
    else process.env.HUB_LIVE_EDIT_TENANTS = prev;
  }
});

test("flags.breaking, flags.aiAssisted, flags.sponsored or flags.affiliate present is rejected flags_locked even when equal to stored", () => {
  const locked = { ok: false, status: 422, body: { ok: false, status: "not_live_editable", reason: "flags_locked" } };
  for (const f of ["breaking", "aiAssisted", "sponsored", "affiliate"]) {
    assert.deepEqual(parseLiveBody(body({ flags: { [f]: false } })), locked, f);
    assert.deepEqual(parseLiveBody(body({ flags: { deepDive: true, [f]: true } })), locked, f);
  }
  const ok = parseLiveBody(body({ flags: { deepDive: true, longHaul: false } }));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.value.flags, { deepDive: true, longHaul: false });
});

test("parseLiveBody rejects tenant, actor, expectedVersion, fields and __proto__ keys inside fields with 400", () => {
  for (const k of ["tenant", "actor", "expectedVersion", "fields", "constructor", "x"]) {
    const r = parseLiveBody(body({ title: "T", [k]: "v" }));
    assert.equal(r.ok, false, k);
    if (!r.ok) {
      assert.equal(r.status, 400, k);
      assert.equal(r.body.field, `fields.${k}`, k);
      assert.equal(r.body.status, "bad_request", k);
    }
  }
  const proto = parseLiveBody(JSON.parse(`{"tenant":"gcv","expectedVersion":4,"actor":${JSON.stringify(ACTOR)},"fields":{"title":"T","__proto__":{"slug":"x"}}}`));
  assert.equal(proto.ok, false);
  if (!proto.ok) assert.deepEqual([proto.status, proto.body.field], [400, "fields.__proto__"]);
  // Outer structure: missing / extra keys ⇒ 400 field:<key>; fields not an object ⇒ 400.
  for (const k of ["tenant", "expectedVersion", "actor", "fields"]) {
    const raw: Doc = body({ title: "T" });
    delete raw[k];
    const r = parseLiveBody(raw);
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual([r.status, r.body.status, r.body.field], [400, "bad_request", k], k);
  }
  const extra = parseLiveBody(body({ title: "T" }, { slug: "x" }));
  assert.equal(!extra.ok && extra.status === 400 && extra.body.field === "slug", true);
  for (const f of [null, [], "x", 3]) {
    const r = parseLiveBody(body(f));
    assert.equal(!r.ok && r.status === 400 && r.body.field === "fields", true);
  }
  assert.equal(parseLiveBody(null).ok, false);
  assert.equal(parseLiveBody([]).ok, false);
  // A present but malformed actor ⇒ 422 invalid from the PATCH parser (bare keys).
  const badActor = parseLiveBody({ tenant: "gcv", expectedVersion: 4, actor: { email: "nope", role: "editor" }, fields: { title: "T" } });
  assert.equal(!badActor.ok && badActor.status === 422 && (badActor.body.fields as Doc)["actor.email"] === "format", true);
  // A value error keeps the PATCH map with the BARE key.
  const badTitle = parseLiveBody(body({ title: "" }));
  assert.equal(!badTitle.ok && badTitle.status === 422 && (badTitle.body.fields as Doc).title === "required", true);
  // Accepted: the flat value carries tenant / actor / expectedVersion and only field keys in `present`.
  const ok = parseLiveBody(body({ title: " T ", dek: null }));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual([ok.value.tenant, ok.value.expectedVersion, ok.value.title, ok.value.dek, ok.value.present], ["gcv", 4, "T", null, ["title", "dek"]]);
});

describe("HUB_LIVE_FIELD_KEYS (D4)", () => {
  it("is HUB_DRAFT_FIELD_KEYS minus slug / heroImageId / leadImageCaption — exactly 15 keys", () => {
    assert.deepEqual([...HUB_LIVE_FIELD_KEYS], [...DERIVED_LIVE_FIELD_KEYS]);
    assert.equal(HUB_LIVE_FIELD_KEYS.length, 15);
  });

  // hub-pin-exclusive-flags (D2 / D13): the three editorial ROOT keys of the draft routes are
  // NOT live keys — under `fields` they stay 400, so buildDraftUpdateData never sees them on /live.
  it("editorial keys under `fields` (exclusive / pinnedToLatest / pinnedUntil) ⇒ 400 field:fields.<key>", () => {
    for (const k of ["exclusive", "pinnedToLatest", "pinnedUntil"]) {
      const r = parseLiveBody(body({ [k]: k === "pinnedUntil" ? null : true }));
      assert.deepEqual([r.ok, !r.ok && r.status, !r.ok && r.body], [false, 400, { ok: false, status: "bad_request", reason: `unknown field: fields.${k}`, field: `fields.${k}` }]);
      assert.equal((HUB_LIVE_FIELD_KEYS as readonly string[]).includes(k), false);
    }
    const ok = parseLiveBody(body({ title: "T" }));
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal("editorial" in ok.value, false);
      assert.deepEqual(ok.value.present, ["title"]);
    }
  });
});
