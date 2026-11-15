import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { useLive } = await import("../live/store.ts");
const { watchRowsMoved } = await import("./reveal.ts");

const S = () => useBrowser.getState();

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/` }));
  return { w, ids };
}

function counting() {
  let moves = 0;
  const stop = watchRowsMoved(() => void moves++);
  return { moves: () => moves, stop };
}

test("rows count as moved when a live folder moves, though the browser store didn't change", () => {
  const watch = counting();
  useLive.setState({ folderOrder: ["b", "a"] });
  assert.equal(watch.moves(), 1);
  watch.stop();
});

test("rows count as moved when a tab is pinned or unpinned, which changes only the tabs", () => {
  const { ids } = windowWith("a", "b");
  const watch = counting();
  S().pinTabs([ids[1]], false);
  assert.ok(watch.moves() >= 1);
  watch.stop();
});

test("a title or load change on a tab doesn't count as rows moving", () => {
  const { ids } = windowWith("a", "b");
  const id = ids[0];
  const watch = counting();
  useBrowser.setState({ tabs: { ...S().tabs, [id]: { ...S().tabs[id], title: "Another title" } } });
  assert.equal(watch.moves(), 0);
  watch.stop();
});

test("stopping the watch unsubscribes from both stores", () => {
  const watch = counting();
  watch.stop();
  useLive.setState({ folderOrder: ["a", "b", "c"] });
  assert.equal(watch.moves(), 0);
});
