import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { numberedTabs } = await import("./entries.ts");
const { runCommand } = await import("../commands/commands.ts");
const { settingsSnapshot } = await import("../telemetry/settingsSnapshot.ts");

const S = () => useBrowser.getState();
const host = (id) => new URL(S().tabs[id].pinnedUrl || S().tabs[id].url).hostname.split(".")[0];
const shown = (w) => host(activeTabId(S(), w));
const press = (w, n) => runCommand(n === 9 ? { command: "selectLastTab", arg: null, windowId: w } : { command: "selectTab", arg: String(n), windowId: w });

function sidebarWithPins(settings = {}) {
  S().hydrate({});
  S().updateSettings(settings);
  const w = S().createWindow({ url: "https://tile.com/" });
  const [tile] = S().windows[w].tabIds;
  const [row, grouped, first, second, last] = ["row", "grouped", "first", "second", "last"].map((h) => S().newTab(w, { url: `https://${h}.com/` }));
  S().pinTabs([tile], true);
  S().pinTabs([row], true, true);
  S().groupTabs([grouped], { pinned: true, name: "Pinned group" });
  S().activate(second);
  return { w, ids: { tile, row, grouped, first, second, last } };
}

test("off by default: ⌘1 is the first Top App, pinned rows and pinned groups count, ⌘9 is the last tab", () => {
  const { w } = sidebarWithPins();
  assert.equal(S().settings.numberedTabsSkipPinned, false);
  assert.deepEqual(numberedTabs(S(), w).map(host), ["tile", "row", "grouped", "first", "second", "last"]);
  press(w, 1);
  assert.equal(shown(w), "tile");
  press(w, 3);
  assert.equal(shown(w), "grouped");
  press(w, 9);
  assert.equal(shown(w), "last");
});

test("on: ⌘1 is the first tab below Top Apps, pinned tabs and pinned groups, and ⌘9 stays the last tab", () => {
  const { w } = sidebarWithPins({ numberedTabsSkipPinned: true });
  assert.deepEqual(numberedTabs(S(), w).map(host), ["first", "second", "last"]);
  press(w, 1);
  assert.equal(shown(w), "first");
  press(w, 3);
  assert.equal(shown(w), "last");
  press(w, 1);
  press(w, 9);
  assert.equal(shown(w), "last");
});

test("on: a number past the last tab leaves the selection alone", () => {
  const { w } = sidebarWithPins({ numberedTabsSkipPinned: true });
  press(w, 4);
  assert.equal(shown(w), "second");
});

test("on, with only pinned tabs open: ⌘1 and ⌘9 do nothing rather than jump to a pinned tab", () => {
  const { w, ids } = sidebarWithPins({ numberedTabsSkipPinned: true });
  S().pinTabs([ids.first, ids.second, ids.last], true, true);
  S().activate(ids.row);
  assert.deepEqual(numberedTabs(S(), w), []);
  press(w, 1);
  assert.equal(shown(w), "row");
  press(w, 9);
  assert.equal(shown(w), "row");
});

test("the daily settings snapshot carries the switch with its default", () => {
  sidebarWithPins({ numberedTabsSkipPinned: true });
  const snapshot = settingsSnapshot(S().settings);
  assert.equal(snapshot.setting_numberedTabsSkipPinned, "true");
  assert.equal(snapshot.default_numberedTabsSkipPinned, "false");
});
