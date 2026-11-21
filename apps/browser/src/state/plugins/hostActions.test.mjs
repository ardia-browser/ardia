import assert from "node:assert/strict";
import { test } from "node:test";
import { useBrowser } from "../browser/store.ts";

test("Split View Options adds a pane on the side picked, and is disabled once the split is full", async () => {
  const { shellNativeModules } = await import("../../test-native/shell.ts");
  const { showSplitSidesMenu } = await import("./hostActions.ts");
  const { splitOf, splitTabIds, MAX_SPLIT_PANES } = await import("../splits/splits.ts");
  const { activeTabId } = await import("../browser/model.ts");
  const S = () => useBrowser.getState();
  S().hydrate({});
  const windowId = S().createWindow({ url: "http://localhost:3000/" });
  const tabId = activeTabId(S(), windowId);
  const menus = shellNativeModules.ArdiaMenus;
  const real = menus.showMenu;
  const shown = [];
  menus.showMenu = (items) => {
    shown.push(items);
    return Promise.resolve("left");
  };
  try {
    await showSplitSidesMenu(tabId);
    const split = splitOf(S(), tabId);
    assert.equal(split?.orientation, "horizontal");
    const panes = splitTabIds(split);
    assert.equal(panes.length, 2);
    assert.deepEqual(panes.slice(1), [tabId], "the new pane went to the left of the page");
    await showSplitSidesMenu(tabId);
    assert.equal(splitTabIds(splitOf(S(), tabId)).length, MAX_SPLIT_PANES);
    await showSplitSidesMenu(tabId);
  } finally {
    menus.showMenu = real;
  }
  const actions = (items) => items.filter((it) => it.id).map((it) => [it.id, it.enabled]);
  assert.deepEqual(actions(shown[0]), [["right", true], ["left", true], ["top", true], ["bottom", true]]);
  assert.deepEqual(actions(shown[2]), [["right", false], ["left", false], ["top", false], ["bottom", false]]);
  assert.equal(splitTabIds(splitOf(S(), tabId)).length, MAX_SPLIT_PANES);
});
