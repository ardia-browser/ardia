import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };

function windowWithTab() {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  const page = S().windows[w].tabIds[0];
  return { w, page };
}

test("duplicating a tab puts the copy right after it, with the same url and profile, and keeps the source open", () => {
  const { w, page } = windowWithTab();
  const copy = S().duplicateTab(page);
  assert.ok(copy, "the duplicate is made");
  assert.notEqual(copy, page);
  const ids = S().windows[w].tabIds;
  assert.deepEqual(ids.slice(0, 2), [page, copy], "the copy sits beside its source");
  assert.equal(S().tabs[copy].url, "https://a.example/");
  assert.equal(S().tabs[copy].profileId, S().tabs[page].profileId);
  assert.ok(S().tabs[page], "the source tab stays open");
});

test("the duplicate starts from the source's page, so it keeps the browsing history", () => {
  const { page } = windowWithTab();
  const copy = S().duplicateTab(page);
  assert.equal(S().tabs[copy].page.kind, "adopted");
  assert.equal(S().tabs[copy].page.adopt, `clone:${page}`);
});

test("a duplicate opened in the background sits beside its source and leaves the source shown", () => {
  const { w, page } = windowWithTab();
  const copy = S().duplicateTab(page, { background: true });
  assert.deepEqual(S().windows[w].tabIds.slice(0, 2), [page, copy]);
  assert.equal(S().windows[w].activeTabIds.default, page, "the source stays the shown tab");
  assert.equal(S().tabs[copy].unseen, true, "the copy is marked unseen, like other background tabs");
  assert.equal(S().tabs[copy].page.adopt, `clone:${page}`, "and still keeps the history");
});

test("a duplicate opened in front becomes the shown tab", () => {
  const { w, page } = windowWithTab();
  const copy = S().duplicateTab(page);
  assert.equal(S().windows[w].activeTabIds.default, copy);
});

test("duplicating a copy that shows another tab's page clones the tab holding that page, so the history comes along", () => {
  S().hydrate({});
  S().createWindow({ url: "https://one.example/" });
  const b = S().createWindow({ url: "https://two.example/" });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const frozen = S().windows[b].tabIds.find((id) => S().tabs[id].page.kind === "frozen");
  assert.ok(frozen, "sharing shows the other window's tab as a frozen copy");
  const holder = S().tabs[frozen].page.holderId;
  const copy = S().duplicateTab(frozen);
  assert.equal(S().tabs[copy].page.adopt, `clone:${holder}`);
});
