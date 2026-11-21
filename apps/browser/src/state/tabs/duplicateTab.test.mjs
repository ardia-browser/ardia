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
