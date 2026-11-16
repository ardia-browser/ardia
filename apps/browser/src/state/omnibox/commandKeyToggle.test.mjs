import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { runCommand } = await import("../commands/commands.ts");
const { openBarFromAddress, registerHeroBar } = await import("./barState.ts");
const { toggleNewTabBar } = await import("./newTabBar.ts");
const { webviews } = await import("../../platform/webviews.ts");

const S = () => useBrowser.getState();
const panel = (w) => S().windowUi[w]?.panel ?? { open: false };
const commandL = (w) => runCommand({ command: "focusCommandBar", arg: null, windowId: w });

function pageWindow(settings = {}) {
  S().hydrate({});
  S().updateSettings({ newTabOpens: "page", ...settings });
  const w = S().createWindow({ url: "https://example.com/" });
  const tab = activeTabId(S(), w);
  const focused = [];
  webviews.set(tab, { focus: async () => void focused.push(tab), focusIfUnfocused: async () => (focused.push(tab), true) });
  return { w, tab, focused };
}

const LAYOUTS = {
  "tabs across the top, bar at the address": { commandBarPlacement: "field", addressBar: "toolbar", tabLayout: "top" },
  "Arc's sidebar, bar at the address": { commandBarPlacement: "field", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: false },
  "sidebar hidden, so the bar opens in the centre": { commandBarPlacement: "field", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: true },
  "In the centre": { commandBarPlacement: "centred", addressBar: "toolbar" },
};

for (const [name, settings] of Object.entries(LAYOUTS)) {
  test(`⌘L on a page opens the address bar and a second ⌘L closes it, giving the page the keyboard (${name})`, () => {
    const { w, tab, focused } = pageWindow(settings);
    commandL(w);
    assert.equal(panel(w).open, true);
    assert.equal(panel(w).initialText, "https://example.com/");
    const placement = panel(w).placement;
    commandL(w);
    assert.equal(panel(w).open, false, "the second ⌘L closes the bar");
    assert.deepEqual(focused, [tab], "the page gets the keyboard back, as after Esc");
    commandL(w);
    assert.equal(panel(w).open, true, "a third ⌘L opens it again");
    assert.equal(panel(w).placement, placement);
  });
}

test("⌘L closes the address bar a click on the address opened", () => {
  const { w, tab, focused } = pageWindow({ commandBarPlacement: "centredOnClick" });
  openBarFromAddress(w, "https://example.com/");
  assert.equal(panel(w).open, true);
  commandL(w);
  assert.equal(panel(w).open, false);
  assert.deepEqual(focused, [tab]);
});

test("on an empty tab with the address in the sidebar, a second ⌘L closes the dropdown and gives the New Tab box its focus back", () => {
  const { w } = pageWindow({ commandBarPlacement: "field", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: false });
  const empty = S().newTab(w, { newTabCommand: true });
  let heroFocus = 0;
  const unregister = registerHeroBar(w, empty, () => void heroFocus++);
  commandL(w);
  assert.equal(panel(w).open, true);
  assert.equal(panel(w).initialText, "");
  commandL(w);
  assert.equal(panel(w).open, false);
  assert.equal(heroFocus, 1);
  unregister();
});

test("on a New Tab page with its own box, ⌘L keeps focusing the box and never opens a bar", () => {
  const { w } = pageWindow({ commandBarPlacement: "field", addressBar: "toolbar" });
  const empty = S().newTab(w, { newTabCommand: true });
  let heroFocus = 0;
  const unregister = registerHeroBar(w, empty, () => void heroFocus++);
  commandL(w);
  commandL(w);
  assert.equal(panel(w).open, false);
  assert.equal(heroFocus, 2);
  unregister();
});

test("with New tab opens the command bar, ⌘L on an empty card shows the New Tab bar and a second ⌘L closes it", () => {
  const { w } = pageWindow();
  S().updateSettings({ newTabOpens: "commandBar" });
  S().newTab(w, { newTabCommand: true });
  commandL(w);
  assert.ok(panel(w).newTab, "the New Tab bar is shown");
  commandL(w);
  assert.equal(panel(w).open, false);
});

test("⌘L over ⌘T's bar on a page switches to the page's address instead of closing", () => {
  const { w } = pageWindow({ newTabOpens: "commandBar" });
  assert.equal(toggleNewTabBar(w), true);
  assert.ok(panel(w).newTab);
  commandL(w);
  assert.equal(panel(w).open, true);
  assert.equal(panel(w).newTab, undefined);
  assert.equal(panel(w).initialText, "https://example.com/");
});

test("Little Ardia: a second ⌘L closes its address dropdown and gives the page the keyboard; a blank one keeps its bar", () => {
  S().hydrate({});
  const small = S().createWindow({ kind: "small", url: "https://little.example/" });
  const tab = activeTabId(S(), small);
  const focused = [];
  webviews.set(tab, { focus: async () => void focused.push(tab) });
  commandL(small);
  assert.equal(panel(small).open, true);
  assert.equal(panel(small).initialText, "https://little.example/");
  commandL(small);
  assert.equal(panel(small).open, false);
  assert.deepEqual(focused, [tab]);

  const blank = S().createWindow({ kind: "small" });
  commandL(blank);
  commandL(blank);
  assert.equal(panel(blank).open, true, "a blank Little Ardia has nothing under its bar, so ⌘L keeps it");
});

test("rapid ⌘L twice retires the opening focus request before a late field claim", async () => {
  const { settlingCommandFocus, cancelAbandonedFocusMoves } = await import("../focus/focusHandoff.ts");
  const { claimFocusTag, commandBarFocus } = await import("../focus/focusClaims.ts");
  const { shellNativeModules } = await import("../../test-native/shell.ts");
  const { w } = pageWindow();
  const cancelled = [], claimed = [];
  const native = shellNativeModules.ArdiaFocus;
  const originalCancel = native.cancelFocusMove, originalClaim = native.claimFocus;
  native.cancelFocusMove = async (generation, restoring) => { cancelled.push([generation, restoring]); };
  native.claimFocus = async (generation, tag) => { claimed.push([generation, tag]); };
  const unsubscribe = cancelAbandonedFocusMoves();
  try {
    for (const focusGeneration of [101, 102]) {
      settlingCommandFocus({ command: "focusCommandBar", windowId: w, focusGeneration }, runCommand);
    }
    assert.equal(panel(w).open, false);
    claimFocusTag(w, commandBarFocus, () => 321);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(claimed, [], "the dismissed field cannot claim the opening request");
    assert.ok(cancelled.some(([generation, restoring]) => generation === 101 && restoring));
    assert.ok(cancelled.some(([generation, restoring]) => generation === 102 && restoring));
  } finally {
    unsubscribe();
    native.cancelFocusMove = originalCancel;
    native.claimFocus = originalClaim;
  }
});
