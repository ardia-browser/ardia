import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { numberedTabs } = await import("../sidebar/entries.ts");
const { swipeToNeighbourTab } = await import("./tabSwipe.ts");

const S = () => useBrowser.getState();
const host = (id) => new URL(S().tabs[id].pinnedUrl || S().tabs[id].url).hostname.replace(".com", "");
const active = (w) => host(activeTabId(S(), w));

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/`, background: true }));
  return { w, ids };
}

test("a tab swipe steps one row through the sidebar's order and stops at either end", () => {
  const { w } = windowWith("a", "b", "c");
  const order = numberedTabs(S(), w).map(host);
  S().activate(numberedTabs(S(), w)[0]);
  const seen = [active(w)];
  while (swipeToNeighbourTab(w, 1, "toolbar")) seen.push(active(w));
  assert.deepEqual(seen, order, "forward visits every row once, in the sidebar's order");
  assert.equal(swipeToNeighbourTab(w, 1, "toolbar"), null, "no wrap past the last row");
  assert.equal(active(w), order.at(-1));
  while (swipeToNeighbourTab(w, -1, "sidebarField"));
  assert.equal(active(w), order[0], "back returns to the first row and stops there");
  assert.equal(swipeToNeighbourTab(w, -1, "toolbar"), null);
});

test("pinned rows come before the list, and a split is one row", () => {
  const { w, ids } = windowWith("a", "b", "c", "d");
  const [, b, c, d] = ids;
  S().pinTabs([d], true, true);
  S().createSplit([b, c]);
  S().activate(d);
  const steps = [active(w)];
  while (swipeToNeighbourTab(w, 1, "toolbar")) steps.push(active(w));
  assert.equal(steps[0], "d", "the pinned row is first");
  assert.equal(steps.filter((h) => h === "b" || h === "c").length, 1, "the split is stepped over as one row");
  assert.deepEqual([...new Set(steps)].length, steps.length, "no row is visited twice");
});
