import { test } from "node:test";
import assert from "node:assert/strict";
import { pinPriorSlugs, planEventSlugs, type SlugPlanEntry } from "./slug-plan";

const plan: SlugPlanEntry[] = [
  { legacyId: "a1", kind: "article", slug: "bali-reopens" },
  { legacyId: "a2", kind: "article", slug: "tokyo-fair" },
  { legacyId: "a3", kind: "article", slug: "new-story" },
];

test("A5: empty prior = the first-run plan, unchanged", () => {
  assert.deepEqual(pinPriorSlugs(plan, new Map()), plan);
});

test("A5: an event of run 1 keeps its Central slug in run 2 (else it collides with itself and is created twice)", () => {
  const ev = [{ id: "e1", title: "Tokyo Travel Expo", dateStart: "2026-03-01" }];
  const run1 = planEventSlugs(ev, plan.map((p) => p.slug));
  assert.equal(run1[0]?.slug, "tokyo-travel-expo");
  // run 2: Central already holds run 1's event slug, so a fresh plan moves it ...
  const run2 = planEventSlugs(ev, [...plan.map((p) => p.slug), "tokyo-travel-expo"]);
  assert.equal(run2[0]?.slug, "tokyo-travel-expo-2026");
  // ... and pinning the earlier run's real slug restores it.
  assert.equal(pinPriorSlugs(run2, new Map([["event:e1", "tokyo-travel-expo"]]))[0]?.slug, "tokyo-travel-expo");
});

test("A5: a new item whose slug is held by an earlier-run item moves to -2 (reported); existing items keep theirs", () => {
  const out = pinPriorSlugs([...plan, { legacyId: "a4", kind: "article", slug: "expo" }, { legacyId: "a5", kind: "article", slug: "expo-2" }], new Map([["a1", "bali-reopens"], ["event:e9", "expo"]]));
  assert.equal(out.find((e) => e.legacyId === "a1")?.slug, "bali-reopens");
  const a4 = out.find((e) => e.legacyId === "a4");
  assert.equal(a4?.slug, "expo-3");
  assert.deepEqual(a4?.slugChanged, { from: "expo", to: "expo-3", reason: "taken-by-earlier-run" });
  assert.equal(new Set(out.map((e) => e.slug)).size, out.length, "no duplicate slugs");
});
