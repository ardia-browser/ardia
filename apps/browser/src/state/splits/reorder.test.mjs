import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { splitOf, splitTabIds } = await import("./splits.ts");
const { paneNeighbor } = await import("./reorder.ts");
const { dropTabIntoSplit, openHorizontalSplitPane, swapSplitPanes } = await import("./actions.ts");
const { beginSplitMoveDrag, cancelSplitMoveDrag, updateSplitMoveDrag } = await import("./moveDrag.ts");
const { runCommand } = await import("../commands/commands.ts");
const { menuState } = await import("../commands/menuState.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { takeSplitReorderCounts } = await import("../telemetry/splitReorderCounts.ts");

function withSharing(run) {
  setConsentPeriod(true, "split-reorder-test");
  takeSplitReorderCounts();
  try {
    run();
  } finally {
    takeSplitReorderCounts();
    setConsentPeriod(false, null);
  }
}

const S = () => useBrowser.getState();

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.example/` });
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.example/`, background: true }));
  S().setFocusedWindow(w);
  return { w, ids };
}

test("paneNeighbor resolves 2D neighbors across horizontal, vertical and stacked split topologies", () => {
  const h2 = { id: "s", windowId: "w", orientation: "horizontal", slots: [{ size: 0.5, tabId: "a" }, { size: 0.5, tabId: "b" }] };
  assert.equal(paneNeighbor(h2, "a", "right"), "b");
  assert.equal(paneNeighbor(h2, "a", "left"), null);
  assert.equal(paneNeighbor(h2, "a", "up"), null);
  assert.equal(paneNeighbor(h2, "b", "left"), "a");

  const v3 = { id: "s", windowId: "w", orientation: "vertical", slots: [{ size: 1 / 3, tabId: "a" }, { size: 1 / 3, tabId: "b" }, { size: 1 / 3, tabId: "c" }] };
  assert.equal(paneNeighbor(v3, "a", "down"), "b");
  assert.equal(paneNeighbor(v3, "b", "up"), "a");
  assert.equal(paneNeighbor(v3, "b", "down"), "c");
  assert.equal(paneNeighbor(v3, "b", "left"), null);
  assert.equal(paneNeighbor(v3, "c", "down"), null);

  const hStack = { id: "s", windowId: "w", orientation: "horizontal", slots: [{ size: 0.5, tabId: "a" }, { size: 0.5, stack: ["b", "c"], stackSizes: [0.5, 0.5] }] };
  assert.equal(paneNeighbor(hStack, "a", "right"), "b");
  assert.equal(paneNeighbor(hStack, "b", "left"), "a");
  assert.equal(paneNeighbor(hStack, "b", "down"), "c");
  assert.equal(paneNeighbor(hStack, "c", "up"), "b");
  assert.equal(paneNeighbor(hStack, "c", "left"), "a");

  const vStack = { id: "s", windowId: "w", orientation: "vertical", slots: [{ size: 0.5, tabId: "a" }, { size: 0.5, stack: ["b", "c"], stackSizes: [0.5, 0.5] }] };
  assert.equal(paneNeighbor(vStack, "a", "down"), "b");
  assert.equal(paneNeighbor(vStack, "b", "up"), "a");
  assert.equal(paneNeighbor(vStack, "b", "right"), "c");
  assert.equal(paneNeighbor(vStack, "c", "left"), "b");
  assert.equal(paneNeighbor(vStack, "c", "up"), "a");
});

test("horizontal split creation via drag drop and command creates top/bottom splits and records telemetry", () => {
  withSharing(() => {
    const { ids } = windowWith("a", "b", "c");
    const [a, b, c] = ids;
    assert.equal(dropTabIntoSplit(b, a, "top"), b);
    const split = splitOf(S(), a);
    assert.equal(split.orientation, "vertical");
    assert.deepEqual(splitTabIds(split), [b, a]);

    assert.equal(dropTabIntoSplit(c, a, "bottom"), c);
    assert.deepEqual(splitTabIds(splitOf(S(), a)), [b, a, c]);

    const counts = takeSplitReorderCounts();
    assert.equal(counts.split_horizontal_drops, 2);
    assert.equal(counts.split_vertical_drops, 0);

    const second = windowWith("x");
    const topId = openHorizontalSplitPane(second.w, { side: "top", url: "https://top.example/" });
    assert.ok(topId);
    const topSplit = splitOf(S(), topId);
    assert.equal(topSplit.orientation, "vertical");
    assert.equal(splitTabIds(topSplit)[0], topId);

    const third = windowWith("y");
    runCommand({ command: "openHorizontalSplitPane", arg: null, windowId: third.w });
    const created = splitOf(S(), activeTabId(S(), third.w));
    assert.equal(created.orientation, "vertical");
    assert.equal(splitTabIds(created).length, 2);
    assert.equal(takeSplitReorderCounts().split_horizontal_opens, 2);
  });
});

test("keyboard shortcuts move the active split pane in 2D, update menuState, and keep keyboard focus", () => {
  withSharing(() => {
    const { w, ids } = windowWith("a", "b", "c");
    const [a, b, c] = ids;
    S().createSplit([a, b], "horizontal");
    S().openSplitPane(w, { tabId: c, anchorTabId: b, side: "bottom" });
    const focused = [];
    for (const id of ids) webviews.set(id, { focus: async () => void focused.push(id) });

    S().activate(c);
    assert.deepEqual(
      ["movePaneLeft", "movePaneRight", "movePaneUp", "movePaneDown"].filter((cmd) => !menuState(S()).disabled.includes(cmd)),
      ["movePaneLeft", "movePaneUp"],
    );

    runCommand({ command: "movePaneUp", arg: null, windowId: w });
    assert.deepEqual(splitTabIds(splitOf(S(), c)), [a, c, b]);
    assert.equal(activeTabId(S(), w), c);
    assert.equal(focused.at(-1), c);

    runCommand({ command: "movePaneLeft", arg: null, windowId: w });
    assert.deepEqual(splitTabIds(splitOf(S(), c)), [c, a, b]);
    assert.deepEqual(
      ["movePaneLeft", "movePaneRight", "movePaneUp", "movePaneDown"].filter((cmd) => !menuState(S()).disabled.includes(cmd)),
      ["movePaneRight"],
    );

    runCommand({ command: "movePaneRight", arg: null, windowId: w });
    assert.deepEqual(splitTabIds(splitOf(S(), c)), [a, c, b]);

    runCommand({ command: "movePaneDown", arg: null, windowId: w });
    assert.deepEqual(splitTabIds(splitOf(S(), c)), [a, b, c]);

    assert.equal(takeSplitReorderCounts().split_pane_key_moves, 4);
    webviews.clear();
  });
});

test("swapping and cancelling split pane drags preserve slot sizes and record telemetry", () => {
  withSharing(() => {
    const { w, ids } = windowWith("a", "b");
    const [a, b] = ids;
    const splitId = S().createSplit([a, b], "vertical");
    S().updateSplit(splitId, { sizes: [0.3, 0.7] });

    assert.equal(swapSplitPanes(a, b, "drag"), true);
    assert.deepEqual(splitTabIds(S().splits[splitId]), [b, a]);
    assert.deepEqual(S().splits[splitId].slots.map((slot) => slot.size), [0.3, 0.7]);

    beginSplitMoveDrag(w, a, "toolbar");
    updateSplitMoveDrag(w, a, 20, 0, 4);
    cancelSplitMoveDrag(true, w);
    assert.deepEqual(splitTabIds(S().splits[splitId]), [b, a]);

    const counts = takeSplitReorderCounts();
    assert.equal(counts.split_pane_drag_swaps, 1);
    assert.equal(counts.split_pane_drag_cancels, 1);

    assert.ok(openHorizontalSplitPane(w, { url: "https://third.example/" }));
    assert.equal(splitTabIds(S().splits[splitId]).length, 3);
  });
});
