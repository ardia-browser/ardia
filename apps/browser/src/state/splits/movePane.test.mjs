import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { runCommand } = await import("../commands/commands.ts");
const { menuState } = await import("../commands/menuState.ts");
const { activeTabId } = await import("../browser/model.ts");
const { openSplitPane, swapSplitPanes } = await import("./actions.ts");
const { horizontalNeighbor, verticalNeighbor } = await import("./reorder.ts");
const { splitOf, splitTabIds } = await import("./splits.ts");

const S = () => useBrowser.getState();

test("horizontalNeighbor and verticalNeighbor follow split orientation and stacks", () => {
  const row = { orientation: "horizontal", slots: [{ size: 1 / 3, tabId: "a" }, { size: 1 / 3, tabId: "b" }, { size: 1 / 3, tabId: "c" }] };
  assert.equal(horizontalNeighbor(row, "a", -1), null);
  assert.equal(horizontalNeighbor(row, "a", 1), "b");
  assert.equal(horizontalNeighbor(row, "b", -1), "a");
  assert.equal(horizontalNeighbor(row, "b", 1), "c");
  assert.equal(horizontalNeighbor(row, "c", 1), null);
  assert.equal(verticalNeighbor(row, "b", 1), null);

  const stacked = { orientation: "horizontal", slots: [{ size: 0.5, tabId: "a" }, { size: 0.5, stack: ["b", "c"], stackSizes: [0.5, 0.5] }] };
  assert.equal(horizontalNeighbor(stacked, "a", 1), "b");
  assert.equal(horizontalNeighbor(stacked, "b", -1), "a");
  assert.equal(horizontalNeighbor(stacked, "c", -1), "a");
  assert.equal(horizontalNeighbor(stacked, "b", 1), null);
  assert.equal(verticalNeighbor(stacked, "b", 1), "c");
  assert.equal(verticalNeighbor(stacked, "c", -1), "b");

  const column = { orientation: "vertical", slots: [{ size: 0.5, tabId: "top" }, { size: 0.5, tabId: "bottom" }] };
  assert.equal(horizontalNeighbor(column, "top", 1), null);
  assert.equal(horizontalNeighbor(column, "bottom", -1), null);
  assert.equal(verticalNeighbor(column, "top", 1), "bottom");
  assert.equal(verticalNeighbor(column, "bottom", -1), "top");

  const verticalWithRow = { orientation: "vertical", slots: [{ size: 0.5, tabId: "top" }, { size: 0.5, stack: ["left", "right"], stackSizes: [0.5, 0.5] }] };
  assert.equal(horizontalNeighbor(verticalWithRow, "left", 1), "right");
  assert.equal(horizontalNeighbor(verticalWithRow, "right", -1), "left");
  assert.equal(horizontalNeighbor(verticalWithRow, "top", 1), null);
});

test("movePaneLeft and movePaneRight walk the active pane across a 3-pane split and keep it active", () => {
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), windowId);
  const b = openSplitPane(windowId, { url: "https://b.example/" });
  const c = openSplitPane(windowId, { url: "https://c.example/" });
  const panes = () => splitTabIds(splitOf(S(), a));
  assert.deepEqual(panes(), [a, b, c]);

  S().activate(a);
  runCommand({ command: "movePaneLeft", windowId });
  assert.deepEqual(panes(), [a, b, c]);

  runCommand({ command: "movePaneRight", windowId });
  assert.deepEqual(panes(), [b, a, c]);
  assert.equal(activeTabId(S(), windowId), a);

  runCommand({ command: "movePaneRight", windowId });
  assert.deepEqual(panes(), [b, c, a]);
  assert.equal(activeTabId(S(), windowId), a);

  runCommand({ command: "movePaneRight", windowId });
  assert.deepEqual(panes(), [b, c, a]);

  runCommand({ command: "movePaneLeft", windowId });
  assert.deepEqual(panes(), [b, a, c]);
  assert.equal(activeTabId(S(), windowId), a);
});

test("swapSplitPanes exchanges non-adjacent panes while keeping slot widths in place", () => {
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), windowId);
  const b = openSplitPane(windowId, { url: "https://b.example/" });
  const c = openSplitPane(windowId, { url: "https://c.example/" });
  const split = splitOf(S(), a);
  S().updateSplit(split.id, { sizes: [0.5, 0.25, 0.25] });

  assert.equal(swapSplitPanes(a, c), true);
  const updated = splitOf(S(), a);
  assert.deepEqual(splitTabIds(updated), [c, b, a]);
  assert.deepEqual(updated.slots.map((slot) => slot.size), [0.5, 0.25, 0.25]);
  assert.equal(swapSplitPanes(a, a), false);
  const solo = S().newTab(windowId, { url: "https://solo.example/" });
  assert.equal(swapSplitPanes(a, solo), false);
  assert.equal(swapSplitPanes(solo, a), false);
});

test("movePaneLeft and movePaneRight work on pinned split tabs", () => {
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), windowId);
  const b = openSplitPane(windowId, { url: "https://b.example/" });
  S().togglePin(a);
  assert.equal(S().tabs[a].pin?.as, "row");
  assert.equal(S().tabs[b].pin?.as, "row");
  assert.deepEqual(splitTabIds(splitOf(S(), a)), [a, b]);
  S().activate(a);
  runCommand({ command: "movePaneRight", windowId });
  assert.deepEqual(splitTabIds(splitOf(S(), a)), [b, a]);
  assert.equal(activeTabId(S(), windowId), a);
});

test("menuState enables movePaneLeft and movePaneRight only when the active split pane can move that way", () => {
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://a.example/" });
  S().setFocusedWindow(windowId);
  const a = activeTabId(S(), windowId);
  const disabled = () => new Set(menuState(S()).disabled);

  assert.equal(disabled().has("movePaneLeft"), true);
  assert.equal(disabled().has("movePaneRight"), true);

  const b = openSplitPane(windowId, { url: "https://b.example/" });
  const c = openSplitPane(windowId, { url: "https://c.example/" });

  S().activate(a);
  assert.equal(disabled().has("movePaneLeft"), true);
  assert.equal(disabled().has("movePaneRight"), false);

  S().activate(b);
  assert.equal(disabled().has("movePaneLeft"), false);
  assert.equal(disabled().has("movePaneRight"), false);

  S().activate(c);
  assert.equal(disabled().has("movePaneLeft"), false);
  assert.equal(disabled().has("movePaneRight"), true);

  S().toggleSplitOrientation(splitOf(S(), a).id);
  S().activate(b);
  assert.equal(disabled().has("movePaneLeft"), true);
  assert.equal(disabled().has("movePaneRight"), true);
});
