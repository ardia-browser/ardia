import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { runCommand } = await import("../commands/commands.ts");
const { menuState } = await import("../commands/menuState.ts");
const { dropTabOnPane, showSplitMenu, swapSplitPanes } = await import("./actions.ts");
const { splitOf, splitTabIds } = await import("./splits.ts");
const { splitGeometry } = await import("../../components/window/geometry.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const S = () => useBrowser.getState();

function freshWindow() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://one.example/" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://two.example/", background: true });
  const c = S().newTab(w, { url: "https://three.example/", background: true });
  return { w, a, b, c };
}

const shape = (v) => `${v.orientation}|${v.slots.map((slot) => ("stack" in slot ? slot.stack.join("+") : slot.tabId)).join(",")}`;

async function menuOf(tabId, pick) {
  const menus = shellNativeModules.ArdiaMenus;
  const real = menus.showMenu;
  let shown = [];
  menus.showMenu = (items) => ((shown = items), Promise.resolve(pick ? pick(items) : null));
  try {
    await showSplitMenu(tabId);
  } finally {
    menus.showMenu = real;
  }
  return shown;
}

const arrange = (items) => items.find((it) => it.id === "arrange").children;

test("rearranging a tab already inside a 2-pane or 3-pane split preserves split identity and custom sizes on no-op", () => {
  const { w, a, b, c } = freshWindow();
  const initial = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "right" });
  assert.equal(initial.ok, true);
  S().updateSplit(initial.splitId, { sizes: [0.35, 0.65] });

  const noop = S().openSplitPane(w, { anchorTabId: b, tabId: a, side: "left" });
  assert.equal(noop.ok, true);
  assert.equal(noop.splitId, initial.splitId);
  assert.deepEqual(S().splits[initial.splitId].slots.map((slot) => slot.size), [0.35, 0.65]);

  const rotated = S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "bottom" });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.splitId, initial.splitId);
  assert.equal(S().splits[initial.splitId].orientation, "vertical");

  S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "bottom" });
  const reshaped = S().openSplitPane(w, { anchorTabId: b, tabId: c, side: "right" });
  assert.equal(reshaped.ok, true);
  assert.equal(reshaped.splitId, initial.splitId);
  const { panes } = splitGeometry(S().splits[reshaped.splitId], 1200, 800, 9);
  assert.ok(panes[a].width === 1200 && panes[b].y === panes[c].y && panes[b].x < panes[c].x);
});

test("a full split still re-docks its own panes, keeps its id, and a background move leaves the active tab", () => {
  const { w, a, b, c } = freshWindow();
  const id = S().createSplit([a, b, c]);
  S().activate(a);
  const moved = S().openSplitPane(w, { anchorTabId: a, tabId: c, side: "bottom", background: true });
  assert.deepEqual(moved, { ok: true, tabId: c, splitId: id });
  assert.equal(shape(S().splits[id]), `horizontal|${a}+${c},${b}`);
  assert.equal(S().windows[w].activeTabIds[S().windows[w].profileId], a);
  S().openSplitPane(w, { anchorTabId: b, tabId: a, side: "left" });
  assert.equal(S().windows[w].activeTabIds[S().windows[w].profileId], a);
  assert.deepEqual(Object.keys(S().splits), [id]);
});

test("Move Pane swaps with the geometric neighbor and keeps every size", () => {
  const { a, b, c } = freshWindow();
  const id = S().createSplit([a, b]);
  S().openSplitPane(S().tabs[a].windowId, { anchorTabId: b, tabId: c, side: "bottom" });
  S().updateSplit(id, { sizes: [0.3, 0.7], stackSizes: [0.4, 0.6] });
  const before = S().splits[id];
  assert.equal(S().movePane(a, "up"), false);
  assert.equal(S().movePane(c, "left"), true);
  assert.equal(shape(S().splits[id]), `horizontal|${c},${b}+${a}`);
  assert.deepEqual(S().splits[id].slots.map((slot) => slot.size), before.slots.map((slot) => slot.size));
  assert.deepEqual(S().splits[id].slots[1].stackSizes, [0.4, 0.6]);
  assert.equal(S().swapPanes(a, b), true);
  assert.equal(shape(S().splits[id]), `horizontal|${c},${a}+${b}`);
  assert.equal(S().swapPanes(a, "nope"), false);
});

test("the move commands move the active pane and are disabled where there is no neighbor", () => {
  const { w, a, b } = freshWindow();
  const id = S().createSplit([a, b]);
  S().activate(a);
  const disabled = new Set(menuState(S()).disabled);
  assert.equal(disabled.has("moveSplitPaneRight"), false);
  for (const off of ["moveSplitPaneLeft", "moveSplitPaneUp", "moveSplitPaneDown"]) assert.equal(disabled.has(off), true, off);
  runCommand({ command: "moveSplitPaneRight", windowId: w });
  assert.deepEqual(splitTabIds(S().splits[id]), [b, a]);
  runCommand({ command: "moveSplitPaneUp", windowId: w });
  assert.deepEqual(splitTabIds(S().splits[id]), [b, a]);
  runCommand({ command: "openSplitPaneBelow", windowId: w });
  assert.equal(shape(splitOf(S(), a)).startsWith(`horizontal|${b},${a}+`), true);
});

test("dropping a pane on another pane of its split re-docks it; swapping by drag trades places", () => {
  const { a, b, c } = freshWindow();
  const id = S().createSplit([a, b, c]);
  assert.equal(dropTabOnPane(a, c, "top"), a);
  assert.equal(shape(S().splits[id]), `horizontal|${b},${a}+${c}`);
  assert.equal(swapSplitPanes(b, c, "drag"), true);
  assert.equal(shape(S().splits[id]), `horizontal|${c},${a}+${b}`);
  assert.equal(swapSplitPanes(b, b, "menu"), false);
});

test("the split menu offers Add Right and Add Bottom by the insert rule and moves only along the layout's axes", async () => {
  const { w, a, b, c } = freshWindow();
  S().createSplit([a, b]);
  let items = await menuOf(a);
  assert.deepEqual(items.slice(0, 2).map((it) => [it.id, it.title, it.enabled]), [
    ["addRight", "Add Right Split", true],
    ["addBottom", "Add Bottom Split", true],
  ]);
  assert.deepEqual(arrange(items).map((it) => it.id), ["moveLeft", "moveRight", "flip", "convert"]);
  assert.deepEqual(arrange(items).slice(0, 2).map((it) => it.enabled), [false, true]);

  await menuOf(a, () => "moveRight");
  assert.deepEqual(splitTabIds(splitOf(S(), a)), [b, a]);
  await menuOf(a, () => "addBottom");
  const split = splitOf(S(), a);
  assert.equal(splitTabIds(split).length, 3);
  assert.equal(shape(split).startsWith(`horizontal|${b},${a}+`), true);

  items = await menuOf(a);
  assert.deepEqual(items.slice(0, 2).map((it) => it.enabled), [false, false]);
  assert.deepEqual(arrange(items).map((it) => it.id), ["moveLeft", "moveRight", "moveUp", "moveDown", "flip", "convert"]);
  assert.deepEqual(arrange(items).slice(0, 4).map((it) => it.enabled), [true, false, false, true]);

  S().hydrate({});
  const v = freshWindow();
  S().createSplit([v.a, v.b], "vertical");
  items = await menuOf(v.a);
  assert.deepEqual(arrange(items).map((it) => it.id), ["moveUp", "moveDown", "flip", "convert"]);
  assert.equal(arrange(items).find((it) => it.id === "convert").title, "Convert to Horizontal Split View");
  void [w, c];
});

test("a closed window saved with its two panes in one stacked slot reopens as a plain stacked split that flips and grows normally", () => {
  const { w, a, b } = freshWindow();
  S().createWindow({ url: "https://keep.example/" });
  assert.equal(S().openSplitPane(w, { anchorTabId: a, tabId: b, side: "bottom" }).ok, true);
  S().closeWindow(w);
  const entry = S().closedWindows.at(-1);
  useBrowser.setState({ closedWindows: [...S().closedWindows.slice(0, -1), { ...entry, splits: [{ orientation: "horizontal", slots: [{ size: 1, stack: ["0", "1"], stackSizes: [0.3, 0.7] }] }] }] });
  S().reopenClosedWindow();
  const restored = Object.values(S().splits).find((v) => v.windowId === S().windowOrder.at(-1));
  assert.equal(restored.orientation, "vertical");
  assert.deepEqual(restored.slots.map((slot) => slot.size), [0.3, 0.7]);
  const [top, bottom] = splitTabIds(restored);
  S().flipSplit(restored.id);
  assert.deepEqual(splitTabIds(S().splits[restored.id]), [bottom, top]);
});
