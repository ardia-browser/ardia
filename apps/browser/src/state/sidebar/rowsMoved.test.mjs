import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { useLive } = await import("../live/store.ts");
const { rowsStamp, sameRows, selectedTabSnapshot } = await import("./reveal.ts");

const S = () => useBrowser.getState();

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/` }));
  return { w, ids };
}

test("the rows stamp holds while nothing changes, so the pill's judge re-locates nothing on a plain scroll", () => {
  windowWith("a", "b");
  assert.equal(sameRows(rowsStamp(), rowsStamp()), true);
  assert.equal(sameRows(null, rowsStamp()), false);
});

test("rows count as moved when a live folder moves, though the browser store didn't change", () => {
  windowWith("a");
  const before = rowsStamp();
  useLive.setState({ folderOrder: ["b", "a"] });
  assert.equal(sameRows(before, rowsStamp()), false);
});

test("rows count as moved when a tab is pinned or unpinned, or the selection moves", () => {
  const { w, ids } = windowWith("a", "b");
  let before = rowsStamp();
  S().pinTabs([ids[1]], false);
  assert.equal(sameRows(before, rowsStamp()), false);
  before = rowsStamp();
  S().activate(ids[0]);
  assert.equal(sameRows(before, rowsStamp()), false);
});

test("the pill's tab snapshot is the window's selected tab, read once", () => {
  const { w, ids } = windowWith("a", "b");
  S().activate(ids[1]);
  const tab = selectedTabSnapshot(w);
  assert.equal(tab?.id, ids[1]);
  assert.equal(tab?.url, "https://b.com/");
  assert.equal(typeof tab?.marks, "number", "the icon marks ride along, so the pill draws the row's engine badge");
  assert.equal(selectedTabSnapshot("missing"), null);
});
