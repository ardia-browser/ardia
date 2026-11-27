import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { sidebarModeIn } = await import("../browser/model.ts");
const { chooseSidebarMode } = await import("../settings/actions.ts");
const { collapseWindowToIcons, followWindowWidth } = await import("../sidebar/sidebarMode.ts");
const { flushPersistence, loadSession, startPersistence } = await import("../session/persist.ts");
const { SESSION_DOCUMENT } = await import("../session/sessionDocument.ts");
const { windowRow } = await import("../automation/socketWindows.ts");

const S = () => useBrowser.getState();

function fresh() {
  S().hydrate({});
  return S().createWindow({ url: "https://example.com", frame: [0, 0, 1200, 800] });
}

test("snapping one window to Icons by its edge leaves every other window, and the synced setting, as they were", () => {
  const a = fresh();
  const b = S().createWindow({ url: "https://b.example", frame: [0, 0, 1200, 800] });
  S().toggleSidebar(b);
  assert.equal(sidebarModeIn(S(), b), "hidden");
  collapseWindowToIcons(a);
  assert.deepEqual([sidebarModeIn(S(), a), sidebarModeIn(S(), b)], ["icons", "hidden"]);
  assert.deepEqual([S().settings.autoHideTabs, S().settings.collapsedSidebar], [false, "hidden"]);
  assert.equal(S().settingsMeta.chosen.includes("collapsedSidebar"), false, "nothing queued for sync");
  S().toggleSidebar(a);
  S().toggleSidebar(a);
  assert.equal(sidebarModeIn(S(), a), "icons", "⌘S in that window goes back to its own Icons");
  const c = S().createWindow({ tabIds: [S().windows[a].tabIds[0]] });
  assert.equal(sidebarModeIn(S(), c), "icons", "a window torn off it keeps its mode");
});

test("picking Hidden with tabs across the top keeps the vertical sidebar's remembered style", () => {
  fresh();
  chooseSidebarMode("icons");
  chooseSidebarMode("full", true);
  chooseSidebarMode("hidden", true);
  assert.deepEqual([S().settings.autoHideTabs, S().settings.collapsedSidebar], [true, "icons"]);
});

test("a Full window narrow enough for icons is saved as shown and isn't put back in line at relaunch", () => {
  stub.docs.clear();
  S().hydrate({});
  const stop = startPersistence();
  const a = S().createWindow({ url: "https://example.com", frame: [0, 0, 1200, 800] });
  followWindowWidth(a, 580);
  assert.equal(sidebarModeIn(S(), a), "icons");
  flushPersistence();
  const saved = JSON.parse(stub.docs.get(SESSION_DOCUMENT)).windows.map((w) => w.sidebarOpen);
  assert.deepEqual(saved, [true]);
  assert.equal(loadSession().windowsAgainstAutoHideTabs, 0);
  stop();
});

test("the control socket reports the window's own choice as tabsShown and what it shows as sidebarMode", () => {
  const a = fresh();
  followWindowWidth(a, 580);
  assert.deepEqual([windowRow(S(), a).tabsShown, windowRow(S(), a).sidebarMode], [true, "icons"]);
  S().toggleSidebar(a);
  assert.deepEqual([windowRow(S(), a).tabsShown, windowRow(S(), a).sidebarMode], [false, "hidden"]);
});

test("with Hidden set for every window, a tab torn out of a window snapped to Icons opens in Icons", () => {
  const a = fresh();
  chooseSidebarMode("hidden");
  const second = S().newTab(a, { url: "https://second.example", background: true });
  collapseWindowToIcons(a);
  assert.equal(S().windows[a].autoHideTabs, undefined, "collapsed like the setting, so only its style is its own");
  assert.equal(sidebarModeIn(S(), a), "icons");
  const torn = S().createWindow({ tabIds: [second] });
  assert.equal(sidebarModeIn(S(), torn), "icons");
  const small = S().createWindow({ kind: "small", url: "https://link.example" });
  assert.equal(S().windows[small].collapsedSidebar, undefined, "Little Ardia takes nothing");
});
