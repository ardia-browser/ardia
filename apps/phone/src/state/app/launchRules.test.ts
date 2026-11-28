import assert from "node:assert/strict";
import test from "node:test";
import { launchSheetClosesSearch, manyTabTitle, sampleToast } from "./launchRules.ts";

test("ArdiaToast's sample names give Compose's sample toasts, and an unknown name gives none", () => {
  assert.deepEqual(sampleToast("copied"), { title: "Copied Link", icon: "link" });
  assert.deepEqual(sampleToast("received"), { title: "Tab from MacBook Pro", icon: "laptop" });
  assert.deepEqual(sampleToast("receivedSeveral"), { title: "3 Tabs from MacBook Pro", icon: "laptop" });
  assert.deepEqual(sampleToast("sent"), { title: "Sent to MacBook Pro", detail: "example.com", icon: "sent" });
  assert.equal(sampleToast("pinned")?.icon, "star");
  assert.equal(sampleToast("cleared")?.title, "Cleared Browsing Data");
  assert.equal(sampleToast("downloading"), null);
  assert.equal(sampleToast("downloadsGrouped")?.title, "2 downloads complete");
  assert.equal(sampleToast("downloadFailed")?.title, "Couldn’t download quarterly-report.pdf");
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
