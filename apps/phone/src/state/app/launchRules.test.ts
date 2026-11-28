import assert from "node:assert/strict";
import test from "node:test";
import { launchSheetClosesSearch, manyTabTitle, sampleToast } from "./launchRules.ts";

test("ArdiaToast's sample names give Compose's sample toasts, and an unknown name gives none", () => {
  assert.deepEqual(sampleToast("copied"), { message: "Copied Link", icon: "link" });
  assert.deepEqual(sampleToast("received"), { message: "Tab from MacBook Pro", icon: "laptop" });
  assert.deepEqual(sampleToast("receivedSeveral"), { message: "3 Tabs from MacBook Pro", icon: "laptop" });
  assert.deepEqual(sampleToast("sent"), { message: "Sent to MacBook Pro", icon: "sent" });
  assert.equal(sampleToast("pinned")?.icon, "star");
  assert.equal(sampleToast("cleared")?.message, "Cleared Browsing Data");
  assert.equal(sampleToast("party"), null);
});

test("the deck script's many tabs give every seventh a title long enough to truncate", () => {
  assert.equal(manyTabTitle(1), "Article 2");
  assert.ok(manyTabTitle(7).length > 80);
});

test("a launch sheet or Settings closes the search panel first, as a link does, so its field can't take the keyboard back under the sheet", () => {
  const none = { opensSettings: false, settingsPage: null, openSheet: null };
  assert.equal(launchSheetClosesSearch(none), false);
  for (const openSheet of ["spaces", "archive", "settings", "history", "bookmarks", "downloads"]) assert.equal(launchSheetClosesSearch({ ...none, openSheet }), true, openSheet);
  assert.equal(launchSheetClosesSearch({ ...none, opensSettings: true }), true);
  assert.equal(launchSheetClosesSearch({ ...none, settingsPage: "sync" }), true);
  assert.equal(launchSheetClosesSearch({ ...none, openSheet: "nothing" }), false);
});
