import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { canDropSplitPane, dropTabOnPane, openSplitPane, showSplitMenu } = await import("./actions.ts");
const { runCommand } = await import("../commands/commands.ts");
const { splitTabIds } = await import("./splits.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const S = () => useBrowser.getState();

function fresh() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://one.example/" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://two.example/", background: true });
  const id = S().createSplit([a, b]);
  return { w, a, b, id };
}

function grid() {
  const v = fresh();
  const c = S().newTab(v.w, { url: "https://three.example/", background: true });
  const d = S().newTab(v.w, { url: "https://four.example/", background: true });
  assert.equal(dropTabOnPane(c, v.a, "bottom"), c);
  assert.equal(dropTabOnPane(d, v.b, "bottom"), d);
  return { ...v, c, d };
}

test("pane drops form a grid, reject a fifth pane, and re-dock an existing fourth pane", () => {
  const { w, a, b, c, d, id } = grid();
  assert.deepEqual(S().splits[id].slots.map((slot) => slot.stack), [[a, c], [b, d]]);
  const e = S().newTab(w, { url: "https://five.example/", background: true });
  assert.deepEqual(S().openSplitPane(w, { tabId: e, anchorTabId: a }), { ok: false, reason: "max" });
  assert.equal(openSplitPane(w, { anchorTabId: a }), null);
  assert.equal(Object.keys(S().tabs).length, 5);
  assert.equal(dropTabOnPane(d, b, "left"), d);
  assert.deepEqual(S().splits[id].slots.map((slot) => slot.stack ?? slot.tabId), [[a, c], d, b]);
});

test("Add Bottom Split and the split commands build four panes and disable both additions at the limit", async () => {
  const { w, a, b, id } = fresh();
  const menus = shellNativeModules.ArdiaMenus;
  const real = menus.showMenu;
  try {
    menus.showMenu = () => Promise.resolve("addBottom");
    await showSplitMenu(a);
    S().activate(b);
    runCommand({ command: "openSplitPaneBelow", windowId: w });
    assert.equal(S().splits[id].slots.every((slot) => "stack" in slot), true);
    let shown = [];
    menus.showMenu = (items) => ((shown = items), Promise.resolve(null));
    await showSplitMenu(b);
    assert.deepEqual(shown.slice(0, 2).map((item) => item.enabled), [false, false]);
    assert.equal(splitTabIds(S().splits[id]).length, 4);
    const before = Object.keys(S().tabs).length;
    runCommand({ command: "openSplitPane", windowId: w });
    assert.equal(Object.keys(S().tabs).length, before);
  } finally {
    menus.showMenu = real;
  }
});

test("each grid stack resizes independently, moves swap neighbors, and focus cycles through all panes", () => {
  const { w, a, b, c, d, id } = grid();
  S().updateSplit(id, { sizes: [0.4, 0.6], stackSizes: [0.3, 0.7], stackIndex: 0 });
  S().updateSplit(id, { stackSizes: [0.6, 0.4], stackIndex: 1 });
  assert.deepEqual(S().splits[id].slots.map((slot) => slot.stackSizes), [[0.3, 0.7], [0.6, 0.4]]);
  assert.equal(S().movePane(a, "right"), true);
  assert.deepEqual(splitTabIds(S().splits[id]), [b, c, a, d]);
  assert.equal(S().swapPanes(c, d), true);
  assert.deepEqual(S().splits[id].slots.map((slot) => slot.stackSizes), [[0.3, 0.7], [0.6, 0.4]]);
  const ids = splitTabIds(S().splits[id]);
  S().activate(ids[0]);
  for (const next of [...ids.slice(1), ids[0]]) {
    S().focusPane(w, 1);
    assert.equal(S().windows[w].activeTabIds[S().windows[w].profileId], next);
  }
  S().focusPane(w, -1);
  assert.equal(S().windows[w].activeTabIds[S().windows[w].profileId], ids.at(-1));
  S().flipSplit(id);
  assert.deepEqual(S().splits[id].slots.map((slot) => slot.size), [0.6, 0.4]);
  S().toggleSplitOrientation(id);
  assert.equal(S().splits[id].orientation, "vertical");
  S().separateSplit(id);
  assert.equal(S().splits[id], undefined);
  assert.equal(ids.every((tabId) => !!S().tabs[tabId]), true);
});

test("removing and closing grid panes leaves a stack, then a normalized pair, then no split", () => {
  const { a, b, c, d, id } = grid();
  S().removeTabFromSplit(a);
  assert.deepEqual(S().splits[id].slots.map((slot) => slot.stack ?? slot.tabId), [c, [b, d]]);
  S().closeTabs([c]);
  assert.equal(S().splits[id].orientation, "vertical");
  assert.deepEqual(S().splits[id].slots.map((slot) => slot.tabId), [b, d]);
  S().closeTabs([d]);
  assert.equal(S().splits[id], undefined);
  assert.ok(S().tabs[a]);
  assert.ok(S().tabs[b]);
});


test("pane drop eligibility refuses growing a stack while permitting a second stack and valid re-docks", () => {
  const { w, a, b, id } = fresh();
  const c = S().newTab(w, { url: "https://three.example/", background: true });
  const d = S().newTab(w, { url: "https://four.example/", background: true });
  dropTabOnPane(c, a, "bottom");
  assert.equal(canDropSplitPane(d, a, "bottom"), false);
  assert.equal(canDropSplitPane(d, b, "bottom"), true);
  assert.equal(canDropSplitPane(d, b, "center"), false);
  dropTabOnPane(d, b, "bottom");
  assert.equal(canDropSplitPane(a, b, "bottom"), false);
  assert.equal(canDropSplitPane(a, b, "left"), true);
  assert.equal(canDropSplitPane(a, b, "center"), true);
  assert.equal(canDropSplitPane(a, c, "bottom"), true);
  assert.equal(canDropSplitPane(a, a, "center"), false);
  assert.equal(canDropSplitPane("missing", b, "right"), false);
  assert.equal(splitTabIds(S().splits[id]).length, 4);
});


test("the command bar adds a second stack and hides additions at four panes", async () => {
  const { runBarAction } = await import("../omnibox/runBar.ts");
  const { organizeActions } = await import("../omnibox/organizeActions.ts");
  const { w, a, b, id } = fresh();
  const offers = (action) => organizeActions(S(), w).some((item) => item.id === action);
  S().activate(a);
  assert.equal(offers("split:cross"), true);
  runBarAction("split:cross", w);
  S().activate(b);
  assert.equal(offers("split:cross"), true);
  runBarAction("split:cross", w);
  assert.equal(S().splits[id].slots.every((slot) => "stack" in slot), true);
  S().activate(a);
  assert.equal(offers("split:add"), false);
  assert.equal(offers("split:cross"), false);
  runBarAction("split:add", w);
  assert.equal(splitTabIds(S().splits[id]).length, 4);
});
