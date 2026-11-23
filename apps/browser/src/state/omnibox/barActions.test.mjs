import assert from "node:assert/strict";
import { test } from "node:test";
import { matchActions } from "@ardia/core";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../browser/store.ts");
const { tabLayoutOf } = await import("../browser/model.ts");
const { barActions } = await import("./barActions.ts");
const { runBarAction } = await import("./runBar.ts");
const { runCommand } = await import("../commands/commands.ts");
const { openSidebarMenu } = await import("../sidebar/sidebarMenu.ts");
const { chooseTabLayout } = await import("../settings/actions.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const { takeTabLayoutCounts } = await import("../telemetry/tabLayoutCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "bar-actions-test");

const S = () => useBrowser.getState();
const layoutAction = (w) => barActions(S(), w).find((a) => a.id === "toggleTabLayout");
const firstMatch = (query, w) => matchActions(query, barActions(S(), w))[0]?.action.id;

test("the command bar's layout row reads like the View menu item and names the layout it switches to", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://start.example/" });
  assert.equal(tabLayoutOf(S(), w), "sidebar");
  assert.equal(layoutAction(w)?.title, "Show Tabs Across the Top");
  assert.equal(layoutAction(w)?.icon, "rectangle.topthird.inset.filled");

  runBarAction("toggleTabLayout", w);
  assert.equal(tabLayoutOf(S(), w), "top");
  assert.equal(S().settings.tabLayout, "top");
  assert.equal(layoutAction(w)?.title, "Show Tabs in Sidebar");
  assert.equal(layoutAction(w)?.icon, "sidebar.left");
  S().updateSettings({ sidebarSide: "right" });
  assert.equal(layoutAction(w)?.icon, "sidebar.right");
});

test("typing a name for either layout finds the layout row first", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://start.example/" });
  const queries = ["top tabs", "vertical tabs", "tab layout", "horizontal tabs", "sidebar tabs", "tabs in sidebar", "tabs across the top"];
  for (const layout of ["sidebar", "top"]) {
    if (tabLayoutOf(S(), w) !== layout) runBarAction("toggleTabLayout", w);
    for (const query of queries) assert.equal(firstMatch(query, w), "toggleTabLayout", `${query} with tabs in the ${layout}`);
  }
});

test("each way of switching counts one switch in its direction, and Settings counts none", async () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://start.example/" });
  takeTabLayoutCounts();

  runBarAction("toggleTabLayout", w);
  assert.deepEqual(takeTabLayoutCounts(), { tab_layout_switches_to_top: 1, tab_layout_switches_to_sidebar: 0 });

  runCommand({ command: "toggleTabLayout", windowId: w });
  assert.equal(tabLayoutOf(S(), w), "sidebar");
  assert.deepEqual(takeTabLayoutCounts(), { tab_layout_switches_to_top: 0, tab_layout_switches_to_sidebar: 1 });

  const menus = shellNativeModules.ArdiaMenus;
  const real = menus.showMenu;
  const pick = async (id) => {
    menus.showMenu = () => Promise.resolve(id);
    try {
      await openSidebarMenu(w);
    } finally {
      menus.showMenu = real;
    }
  };
  await pick("layout:top");
  assert.equal(tabLayoutOf(S(), w), "top");
  assert.deepEqual(takeTabLayoutCounts(), { tab_layout_switches_to_top: 1, tab_layout_switches_to_sidebar: 0 });
  await pick("layout:top");
  assert.deepEqual(takeTabLayoutCounts(), { tab_layout_switches_to_top: 0, tab_layout_switches_to_sidebar: 0 }, "picking the layout already shown switches nothing");
  await pick("layout:sidebarRight");
  assert.equal(tabLayoutOf(S(), w), "sidebar");
  assert.equal(S().settings.sidebarSide, "right");
  assert.deepEqual(takeTabLayoutCounts(), { tab_layout_switches_to_top: 0, tab_layout_switches_to_sidebar: 1 });
  await pick("layout:top");
  S().updateSettings({ sidebarSide: "left" });
  takeTabLayoutCounts();

  chooseTabLayout("sidebar");
  assert.equal(tabLayoutOf(S(), w), "sidebar");
  assert.deepEqual(takeTabLayoutCounts(), { tab_layout_switches_to_top: 0, tab_layout_switches_to_sidebar: 0 });
});

test("Little Ardia's command bar leaves out the layout row and the other commands its menus disable", () => {
  S().hydrate({});
  const main = S().createWindow({ url: "https://main.example/" });
  const little = S().createWindow({ kind: "small", url: "https://little.example/" });
  assert.ok(layoutAction(main));
  assert.equal(layoutAction(little), undefined);
  const ids = barActions(S(), little).map((a) => a.id);
  for (const command of ["closeAllTabs", "toggleSidebar"]) assert.ok(!ids.includes(command), command);
  assert.ok(ids.includes("reload"));
});
