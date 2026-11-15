import assert from "node:assert/strict";
import { test } from "node:test";
globalThis.acTestNativeModules = { ArdiaSharedFolders: { location: () => ({ path: "/scratch", iCloudAvailable: true, iCloudPath: "/scratch" }) } };
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { menuState } = await import("../commands/menuState.ts");
const { runCommand } = await import("../commands/commands.ts");
const { takeRecentlyClosedCounts } = await import("../telemetry/recentlyClosedCounts.ts");
const { focusedWindowOf } = await import("./ui.ts");
const { lastWindowToRestore } = await import("./reopenClosed.ts");
const { openOverflowMenu } = await import("../sidebar/menus.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const S = () => useBrowser.getState();

function closeThree(windowId, prefix) {
  for (const name of ["a", "b", "c"]) {
    const tabId = S().newTab(windowId, { url: `https://${prefix}${name}.example/` });
    S().closeTab(tabId);
  }
}

test("Clear Recently Closed empties the list for the window's profile and leaves other profiles' lists", () => {
  const home = S().createWindow({ url: "https://keep.example/" });
  const work = S().createProfile({ name: "Work" });
  const other = S().createWindow({ url: "https://work.example/", profileId: work });
  closeThree(home, "home-");
  closeThree(other, "work-");
  S().setFocusedWindow(home);
  const homeProfile = S().windows[home].profileId;
  const closedFor = (profile) => S().closedTabs.filter((c) => c.tab.profileId === profile).length;
  assert.equal(closedFor(homeProfile), 3);
  assert.equal(closedFor(work), 3);
  takeRecentlyClosedCounts();

  runCommand({ command: "clearRecentlyClosed", arg: null, windowId: home });
  assert.equal(closedFor(homeProfile), 0);
  assert.equal(closedFor(work), 3);
  const before = S().tabs;
  S().reopenClosed(home);
  assert.equal(S().tabs, before, "⇧⌘T reopens nothing in the cleared profile");
  assert.deepEqual(takeRecentlyClosedCounts(), { recently_closed_clears: 1, recently_closed_entries_cleared: 3 });

  S().clearRecentlyClosed(home);
  assert.deepEqual(takeRecentlyClosedCounts(), { recently_closed_clears: 0, recently_closed_entries_cleared: 0 }, "an empty list counts no clear");
  assert.ok(model.activeTabId(S(), other));
});

test("the menu item is off while the window's Recently Closed list is empty", () => {
  const w = S().createWindow({ url: "https://menu.example/" });
  S().setFocusedWindow(w);
  S().clearRecentlyClosed(w);
  for (const c of S().closedGroups) assert.notEqual(c.tabs[0]?.profileId, S().windows[w].profileId);
  const disabled = () => menuState(S()).disabled.includes("clearRecentlyClosed");
  assert.equal(menuState(S()).recentlyClosed.length, 0);
  assert.ok(disabled());
  S().closeTab(S().newTab(w, { url: "https://menu-closed.example/" }));
  assert.equal(menuState(S()).recentlyClosed.length, 1);
  assert.ok(!disabled());
  runCommand({ command: "clearRecentlyClosed", arg: null, windowId: w });
  assert.equal(menuState(S()).recentlyClosed.length, 0);
});

const counts = () => ({ tabs: S().closedTabs.length, windows: S().closedWindows.length, groups: S().closedGroups.length });
const closedIn = (profile) => S().closedTabs.filter((c) => c.tab.profileId === profile).length;
const offInMenu = () => menuState(S()).disabled.includes("clearRecentlyClosed");

test("in a private window Clear Recently Closed is off and clears nothing, not the regular profiles' lists nor its own closed tabs", () => {
  const home = S().createWindow({ url: "https://private-home.example/" });
  const work = S().createProfile({ name: "Private Work" });
  const other = S().createWindow({ url: "https://private-work.example/", profileId: work });
  closeThree(home, "p-home-");
  closeThree(other, "p-work-");
  const secret = S().createWindow({ kind: "private", url: "https://secret.example/" });
  S().closeTab(S().newTab(secret, { url: "https://secret-closed.example/" }));
  S().setFocusedWindow(secret);
  const before = counts();
  assert.ok(S().closedTabs.some((c) => c.windowId === secret), "the private window's closed tab is kept for ⇧⌘T");
  assert.ok(offInMenu());
  runCommand({ command: "clearRecentlyClosed", arg: null, windowId: secret });
  S().clearRecentlyClosed(secret);
  assert.deepEqual(counts(), before);
  assert.equal(closedIn(work), 3);
});

test("from Little Ardia Clear Recently Closed clears Little Ardia's own list and leaves the front and the main windows alone", () => {
  const main = S().createWindow({ url: "https://little-main.example/" });
  const work = S().createProfile({ name: "Little Work" });
  const little = S().createWindow({ kind: "small", url: "https://little.example/", profileId: work });
  closeThree(main, "l-main-");
  const workTab = S().createWindow({ url: "https://little-work.example/", profileId: work });
  closeThree(workTab, "l-work-");
  S().closeWindow(workTab);
  S().setFocusedWindow(little);
  const mainProfile = S().windows[main].profileId;
  const mainBefore = closedIn(mainProfile);
  assert.ok(closedIn(work) >= 3);
  assert.ok(!offInMenu());
  runCommand({ command: "clearRecentlyClosed", arg: null, windowId: little });
  assert.equal(focusedWindowOf(S()), little, "the main window isn't brought to the front");
  assert.equal(closedIn(work), 0);
  assert.equal(S().closedWindows.filter((c) => c.window.profileId === work).length, 0);
  assert.equal(closedIn(mainProfile), mainBefore, "the main window's profile keeps its list");
  assert.ok(offInMenu());
});

test("with no window open Clear Recently Closed is off and keeps the window the Dock brings back", () => {
  for (const id of Object.keys(S().windows)) S().closeWindow(id);
  const last = S().createWindow({ url: "https://kept.example/" });
  S().newTab(last, { url: "https://kept-two.example/" });
  S().closeTab(S().newTab(last, { url: "https://kept-closed.example/" }));
  S().closeWindow(last, { keepsLastWindow: true });
  assert.equal(Object.keys(S().windows).length, 0);
  const kept = lastWindowToRestore(S());
  assert.ok(kept);
  const before = counts();
  assert.ok(offInMenu());
  runCommand({ command: "clearRecentlyClosed", arg: null, windowId: null });
  S().clearRecentlyClosed(null);
  assert.deepEqual(counts(), before);
  assert.equal(lastWindowToRestore(S()), kept);
});

test("Little Ardia's Clear keeps the window the Dock brings back while that window is past the shown list, and clears it once it's shown", () => {
  for (const id of Object.keys(S().windows)) S().closeWindow(id);
  const last = S().createWindow({ url: "https://dock.example/" });
  S().closeWindow(last, { keepsLastWindow: true });
  const kept = lastWindowToRestore(S());
  assert.ok(kept);
  const little = S().createWindow({ kind: "small", url: "https://dock-little.example/" });
  S().setFocusedWindow(little);
  S().clearRecentlyClosed(little);
  assert.equal(lastWindowToRestore(S()), undefined, "shown in the list, so Clear removes it");

  const again = S().createWindow({ url: "https://dock-again.example/" });
  S().closeWindow(little);
  S().closeWindow(again, { keepsLastWindow: true });
  const keptAgain = lastWindowToRestore(S());
  assert.ok(keptAgain);
  for (let i = 0; i < 11; i++) S().closeWindow(S().createWindow({ kind: "small", url: `https://dock-${i}.example/` }));
  const littleAgain = S().createWindow({ kind: "small", url: "https://dock-little-again.example/" });
  S().setFocusedWindow(littleAgain);
  assert.ok(!menuState(S()).recentlyClosed.some((e) => e.id === keptAgain.id), "eleven Little Ardia pages closed after it push it past the ten shown");
  S().clearRecentlyClosed(littleAgain);
  assert.equal(lastWindowToRestore(S()), keptAgain);
  assert.equal(menuState(S()).recentlyClosed.length, 1);
});

test("the sidebar overflow's Recently Closed lists exactly what its Clear removes", async () => {
  for (const id of Object.keys(S().windows)) S().closeWindow(id);
  S().clearRecentlyClosed(S().createWindow({ url: "https://wipe.example/" }));
  const work = S().createProfile({ name: "Overflow Work" });
  const elsewhere = S().createWindow({ url: "https://overflow-work.example/", profileId: work });
  const workTab = S().newTab(elsewhere, { url: "https://overflow-work-group.example/" });
  S().closeGroup(S().createGroup([workTab], { name: "Work group" }));
  const w = S().createWindow({ url: "https://overflow.example/" });
  closeThree(w, "o-");
  const spare = S().createWindow({ url: "https://overflow-spare.example/" });
  S().closeWindow(spare);
  S().setFocusedWindow(w);
  takeRecentlyClosedCounts();
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  let listed = [];
  shell.showMenu = (shown) => {
    const closed = shown.find((it) => it.id === "closed").children;
    listed = closed.filter((it) => !it.separator && it.title !== "Clear Recently Closed").map((it) => it.title);
    return Promise.resolve(closed.find((it) => it.title === "Clear Recently Closed").id);
  };
  try {
    await openOverflowMenu(w);
  } finally {
    shell.showMenu = real;
  }
  assert.ok(!listed.includes("Work group (1 Tab)"), listed.join(", "));
  assert.ok(listed.some((t) => t.startsWith("Window")), listed.join(", "));
  assert.equal(takeRecentlyClosedCounts().recently_closed_entries_cleared, listed.length);
  assert.equal(S().closedGroups.filter((c) => c.tabs[0].profileId === work).length, 1);
});
