import assert from "node:assert/strict";
import test from "node:test";
import { EXAMPLE, legacyRead, NEWS, OTTER, T } from "../../../test/legacyFixture.ts";
import { exclusionCounts, hiddenHistoryFromSeconds, importPreferences, planTabs, planVisit, readReceipt, samePreference } from "./importRules.ts";

test("open tabs keep their order, state, profile, received keys and look; bad addresses are counted, not lost silently", () => {
  const plan = planTabs(legacyRead(), "android");
  const open = plan.tabs.filter((t) => t.archivedAt === null);
  assert.deepEqual(open.map((t) => t.id), [OTTER, EXAMPLE]);
  const otter = open[0]!;
  assert.equal(otter.position, 1024);
  assert.equal(otter.profileSyncId, "work");
  assert.equal(otter.origin, "search");
  assert.equal(otter.faviconUrl, "https://en.wikipedia.org/favicon.ico");
  assert.equal(otter.themeColorHex, "#FFFFFF");
  assert.equal(otter.created, T);
  assert.equal(open[1]!.receivedKey, "k-1");
  assert.equal(open[1]!.receivedFromDevice, "Mac Studio");
  assert.equal(open[1]!.origin, "sent");
  assert.deepEqual([...plan.states], [[OTTER, "AAECAw=="], [NEWS, "BAUG"]]);
  assert.deepEqual(plan.excluded, { tabs: { notWeb: 1 }, archive: {} });
});

test("the archive comes with its archive time, state and thumbnail, and an unknown origin reads as typed", () => {
  const [archived] = planTabs(legacyRead(), "android").tabs.filter((t) => t.archivedAt !== null);
  assert.equal(archived!.archivedAt, T - 7_000);
  assert.equal(archived!.origin, "typed");
  assert.match(archived!.snapshotFileName!, /^file:\/\/.*news-1-300x600\.jpg$/);
});

test("a malformed tab, a blank id and a repeated id are each counted under their own reason", () => {
  const read = legacyRead();
  read.tabs.push({ ...read.tabs[0]!, created: Number.NaN } as never, { ...read.tabs[0]!, id: "  " }, { ...read.tabs[1]! });
  read.archive.push({ url: 5 } as never);
  assert.deepEqual(planTabs(read, "android").excluded, { tabs: { notWeb: 1, malformed: 2, duplicate: 1 }, archive: { malformed: 1 } });
});

test("visits keep their transitions, an unknown one reads as other, and anything else is a counted exclusion", () => {
  assert.deepEqual(planVisit({ url: "https://example.com/", title: "E", visitedAt: T, transition: "hyperjump", profileSyncId: "work" }), {
    url: "https://example.com/",
    title: "E",
    visitedAt: T,
    profileSyncId: "work",
    transition: "other",
  });
  assert.equal(planVisit({ url: "javascript:void(0)", title: "", visitedAt: T, transition: "link" }), "notWeb");
  assert.equal(planVisit({ url: "https://example.com/", title: null, visitedAt: T, transition: "link" }), "malformed");
  assert.equal(planVisit(null), "malformed");
});

test("preferences arrive as strings and land only when their value is one the app understands", () => {
  const { values, excluded } = importPreferences(legacyRead().preferences);
  assert.deepEqual(Object.keys(values).sort(), [
    "browsing.nightShade",
    "browsing.searchEngine",
    "browsing.searchSuggestions",
    "reader.serif",
    "reader.sizeStep",
    "settings.autoOpenKeyboard",
    "settings.color",
    "settings.finishedOnboarding",
    "tabs.autoArchiveInterval",
  ]);
  assert.deepEqual(excluded, { unknownKey: 1, empty: 1, badValue: 1 });
  assert.deepEqual(importPreferences({ "reader.sizeStep": { deep: true }, "settings.finishedOnboarding": "yes" }).excluded, { badValue: 2 });
});

test("the deck's grid choice and History's hidden entries come across from main's own keys", () => {
  const hidden = { personal: { "https://news.example/": 1763270000.5 }, work: {} };
  const { values, excluded } = importPreferences({ "tabs.deckGrid": true, "library.hiddenHistory": JSON.stringify(hidden) });
  assert.equal(values["tabs.deckGrid"], "true");
  assert.deepEqual(JSON.parse(values["library.hiddenHistory"]!), { personal: { "https://news.example/": 1763270000500 } });
  assert.deepEqual(excluded, {});
  assert.deepEqual(importPreferences({ "tabs.deckGrid": "maybe", "library.hiddenHistory": "{}" }).excluded, { badValue: 2 });
  assert.equal(hiddenHistoryFromSeconds(JSON.stringify({ personal: { "https://a.example/": "soon" } })), undefined);
  assert.equal(hiddenHistoryFromSeconds("not json"), undefined);
  assert.equal(samePreference("tabs.deckGrid", "true", "true"), true);
  assert.equal(samePreference("library.hiddenHistory", "{}", "{\"a\":{}}"), false);
});

test("a preference is checked by its value and its typed meaning, not just by being there", () => {
  assert.equal(samePreference("reader.sizeStep", "4", "4"), true);
  assert.equal(samePreference("reader.sizeStep", "5", "4"), false);
  assert.equal(samePreference("reader.sizeStep", undefined, "4"), false);
});

test("only a versioned receipt with whole counts counts as one", () => {
  assert.deepEqual(readReceipt(JSON.stringify({ version: 1, tabs: 2, archive: 1, visits: 4, preferences: 9 })), { version: 1, tabs: 2, archive: 1, visits: 4, preferences: 9 });
  for (const raw of [undefined, "", "{", "1", JSON.stringify({ version: 2, tabs: 0, archive: 0, visits: 0, preferences: 0 }), JSON.stringify({ version: 1, tabs: -1, archive: 0, visits: 0, preferences: 0 }), JSON.stringify({ version: 1, tabs: 1.5, archive: 0, visits: 0, preferences: 0 })]) {
    assert.equal(readReceipt(raw), null, String(raw));
  }
});

test("the exclusion summary is reason codes and counts only", () => {
  assert.equal(exclusionCounts({ tabs: { notWeb: 1 }, visits: {}, preferences: { badValue: 2 } }), "tabs.notWeb=1 preferences.badValue=2");
});
