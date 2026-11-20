import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../browser/store.ts");
const { chromeChanged } = await import("./liveTabs.ts");
const { patchPage } = await import("./pageState.ts");
const { useMedia } = await import("../media/media.ts");
const { startTabReveal } = await import("./tabReveal.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
startTabReveal();
const tab = (id, windowId, url, profileId = "default") => ({
  id, windowId, profileId, url, title: "", favicon: null, pin: null, muted: false, zoom: 1, customTitle: null, customIcon: null,
  pinnedUrl: null, page: url ? { kind: "loaded", nav: { url, seq: 1 } } : { kind: "idle" }, openerId: null, createdAt: 0, lastActiveAt: 0,
});
const win = (id, tabIds, active, extra = {}) => ({
  id, profileId: "default", kind: "main", tabIds, activeTabIds: { default: active }, sidebarOpen: true, frame: null, createdAt: 0, ...extra,
});
const PROFILES = {
  default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 },
  work: { id: "work", name: "Work", color: "blue", icon: null, createdAt: 0 },
};
const setup = (tabs = ["a", "b", "c"], active = "a", more = {}) => {
  const windows = { w1: win("w1", tabs, active), ...(more.windows ?? {}) };
  const all = [...tabs.map((id) => tab(id, "w1", `https://${id}.com/`)), ...(more.tabs ?? [])];
  S().hydrate({ profiles: PROFILES, windows, tabs: Object.fromEntries(all.map((t) => [t.id, t])), focusedWindowId: "w1" });
  for (const t of all) S().updateTab(t.id, { page: { kind: "loaded", nav: { url: t.url, seq: 1 } } });
  stub.revealedTabs.length = 0;
};
const revealed = () => {
  const out = [...stub.revealedTabs];
  stub.revealedTabs.length = 0;
  return out;
};

test("a click or ⌘-number switch shows the page before React commits", () => {
  setup();
  S().activate("b");
  assert.deepEqual(revealed(), ["b"]);
  S().activate("b");
  assert.deepEqual(revealed(), [], "the tab already in front: nothing");
  S().activate("c");
  S().activate("a");
  assert.deepEqual(revealed(), ["c", "a"], "each switch tells the window, so a switch back ends the one before it");
});

test("closing the tab in front shows the one JS picks next", () => {
  setup(["a", "b", "c"], "b");
  S().closeTab("b");
  const next = S().windows.w1.activeTabIds.default;
  assert.ok(next && next !== "b");
  assert.deepEqual(revealed(), [next]);
});

test("a switch Chrome made (DevTools, an extension) is shown once the store follows it", () => {
  setup(["a", "b"], "a");
  const before = { strip: 1, window: 1, profile: "", tabs: [{ key: "a", browser: 1, index: 0, active: true, pinned: false }, { key: "b", browser: 2, index: 1, active: false, pinned: false }] };
  const after = { ...before, tabs: [{ ...before.tabs[0], active: false }, { ...before.tabs[1], active: true }] };
  useBrowser.setState(chromeChanged(S(), before, after, { seen: new Set(["a", "b"]) }));
  assert.equal(S().windows.w1.activeTabIds.default, "b");
  assert.deepEqual(revealed(), ["b"]);
});

test("a switch the native view can't show by itself ends any reveal in that window instead", () => {
  setup(["a", "b", "c", "d", "e", "f"], "a");
  S().updateTab("b", { page: { kind: "asleep" } });
  S().activate("b");
  assert.deepEqual(revealed(), ["drop over a"], "a sleeping tab wakes through React");
  S().activate("a");
  assert.deepEqual(revealed(), ["a"]);
  S().updateTab("c", { url: "", page: { kind: "idle" } });
  S().activate("c");
  assert.deepEqual(revealed(), ["drop over a"], "a New Tab page");
  S().activate("a");
  revealed();
  patchPage("d", { newTabShown: { url: "", title: "", favicon: null } });
  S().activate("d");
  assert.deepEqual(revealed(), ["drop over a"], "a page under the New Tab page");
  patchPage("d", { newTabShown: null });
  S().activate("a");
  revealed();
  patchPage("e", { crashed: { status: 1, reason: "crashed", code: 0 } });
  S().activate("e");
  assert.deepEqual(revealed(), ["drop over a"], "a crashed page, which shows the sad tab over it");
  patchPage("e", { crashed: null });
  S().activate("a");
  revealed();
  useMedia.setState({ tabShares: { f: { dismissed: {} } } });
  S().activate("f");
  assert.deepEqual(revealed(), ["drop over a"], "while a tab is shared, the share bar changes the page's height");
  useMedia.setState({ tabShares: {} });
  S().activate("a");
  revealed();
  patchPage("a", { fullscreen: true });
  S().activate("d");
  assert.deepEqual(revealed(), ["drop over a"], "leaving a full-screen page");
  patchPage("a", { fullscreen: false });
});

test("splits and profile switches are left to React", () => {
  setup(["a", "b", "c"], "a");
  S().createSplit(["b", "c"]);
  revealed();
  S().activate("b");
  assert.deepEqual(revealed(), ["drop over a"], "into a split");
  S().activate("a");
  assert.deepEqual(revealed(), ["drop over b"], "out of a split");
  setup(["a", "b"], "a");
  useBrowser.setState((s) => ({
    tabs: { ...s.tabs, b: { ...s.tabs.b, profileId: "work" } },
    windows: { ...s.windows, w1: { ...s.windows.w1, profileId: "work", activeTabIds: { default: "a", work: "b" } } },
  }));
  assert.deepEqual(revealed(), ["drop over a"], "another profile's page");
});

test("a tab moved in from another window and shown there is left to React", () => {
  setup(["a"], "a", { windows: { w2: win("w2", ["x", "y"], "x") }, tabs: [tab("x", "w2", "https://x.com/"), tab("y", "w2", "https://y.com/")] });
  S().moveTabsToWindow(["y"], "w1");
  assert.equal(S().windows.w1.activeTabIds.default, "y");
  assert.ok(!revealed().includes("y"), "its view still sits in the window it leaves");
});

test("a page Chrome opened in front (a link's new tab, DevTools, an extension) is shown over the page it replaces", () => {
  setup(["a", "b"], "a");
  const made = S().newTab("w1", { url: "https://made.example/", adoptId: "tab:5" });
  assert.deepEqual(revealed(), ["tab:5 over a"]);
  assert.equal(S().windows.w1.activeTabIds.default, made);
  S().newTab("w1", { url: "https://behind.example/", adoptId: "tab:6", background: true });
  assert.deepEqual(revealed(), [], "in the background");
  S().newTab("w1", { url: "https://dup.example/", adoptId: "clone:a" });
  assert.deepEqual(revealed(), [`drop over ${made}`], "a duplicate made from a tab");
  S().activate("b");
  revealed();
  patchPage("b", { newTabShown: { url: "", title: "", favicon: null } });
  S().newTab("w1", { url: "https://other.example/", adoptId: "tab:7" });
  assert.deepEqual(revealed(), ["drop over b"], "over a New Tab page");
  patchPage("b", { newTabShown: null });
});

test("a new tab isn't shown over a page whose toolbar is scrolled away (its page is taller than the new tab's)", async () => {
  const { useToolbarAutoHide } = await import("../windows/toolbarAutoHide.ts");
  setup(["a"], "a");
  useToolbarAutoHide.setState({ scrolledDown: { a: true } });
  S().newTab("w1", { url: "https://made.example/", adoptId: "tab:8" });
  assert.deepEqual(revealed(), ["drop over a"]);
  useToolbarAutoHide.setState({ scrolledDown: {} });
});

test("the native switch is on from the start on this platform, and off while a tab is shared", () => {
  assert.equal(stub.nativeTabSwitches[0], true);
  stub.nativeTabSwitches.length = 0;
  useMedia.setState({ tabShares: { a: { kind: "screen" } } });
  useMedia.setState({ tabShares: { a: { kind: "screen" }, b: { kind: "screen" } } });
  useMedia.setState({ tabShares: {} });
  assert.deepEqual(stub.nativeTabSwitches, [false, true], "it's told only when that changes");
});

test("a press carries its native sequence to the switch it makes, and one that leaves its tab behind takes back only its own reveal", async () => {
  const held = await import("../sidebar/heldTabPress.ts");
  const presses = stub.nativeTabPresses;
  let start = 5000;
  const event = (mods = {}) => ({ nativeEvent: { identifier: "0", pageX: 10, pageY: 10, ...mods }, touchHistory: { touchBank: [{ startTimeStamp: ++start }] } });
  const press = (tabId, mods = {}, native = 0) => {
    const e = event(mods);
    if (native) presses.byStart.set(start, native);
    return held.holdTabPress("w1", tabId, e);
  };
  const dropped = () => presses.dropped.splice(0);
  setup();
  press("b", {}, 7);
  assert.deepEqual(revealed(), ["b by press 7"], "native code can tell this switch from the presses after it");
  assert.deepEqual(dropped(), [], "the press switched, nothing to take back");
  S().activate("c");
  assert.deepEqual(revealed(), ["c"], "a selection no press made carries none, so it wins over any press");
  press("c");
  assert.deepEqual([revealed(), dropped()], [[], []], "a press on the tab already in front");
  press("a", { metaKey: true });
  assert.deepEqual([revealed(), dropped()], [[], []], "native code doesn't show a modified click, so nothing to take back");
  S().setSelection("w1", ["a", "b"]);
  const selected = press("b", {}, 9);
  assert.deepEqual([revealed(), dropped()], [[], [9]], "a press on a selected tab doesn't switch on press: only press 9's reveal goes");
  held.clickHeldTabPress("w1", "b", event(), selected);
  assert.deepEqual(revealed(), ["b by press 9"], "its switch on release still belongs to that press");
  S().setSelection("w1", []);
  held.devTabPress.switchOnPress = false;
  try {
    press("a", {}, 12);
    assert.deepEqual([revealed(), dropped()], [[], [12]], "with switching on press off, the press leaves it in the background");
  } finally {
    held.devTabPress.switchOnPress = true;
  }
});

test("a switch the native view can't show still names the press that made it and the tab it goes to", async () => {
  const held = await import("../sidebar/heldTabPress.ts");
  setup();
  S().updateTab("b", { page: { kind: "asleep" } });
  revealed();
  stub.nativeTabPresses.byStart.set(9001, 21);
  held.holdTabPress("w1", "b", { nativeEvent: { identifier: "0", pageX: 10, pageY: 10 }, touchHistory: { touchBank: [{ startTimeStamp: 9001 }] } });
  assert.deepEqual(revealed(), ["drop over a by press 21"], "so a page pressed after it stays on screen");
});

test("a press claims the number native code gave that very event, never an older press on the same tab", async () => {
  const held = await import("../sidebar/heldTabPress.ts");
  const event = (startTimeStamp) => ({ nativeEvent: { identifier: "0", pageX: 10, pageY: 10 }, touchHistory: { touchBank: [{ startTimeStamp }] } });
  setup();
  revealed();
  stub.nativeTabPresses.byStart.set(7000, 30);
  stub.nativeTabPresses.byStart.set(7500, 31);
  held.holdTabPress("w1", "b", event(7500));
  assert.deepEqual(revealed(), ["b by press 31"], "press 30 on the same row, which JS never heard, is not taken for it");
  S().activate("a");
  revealed();
  held.holdTabPress("w1", "b", event(8000));
  assert.deepEqual(revealed(), ["b"], "an event native code never numbered claims nothing");
  S().activate("a");
  revealed();
  held.holdTabPress("w1", "b", { nativeEvent: { identifier: "0", pageX: 10, pageY: 10 } });
  assert.deepEqual(revealed(), ["b"], "nor does one with no start time");
});

test("rows of tabs in a split are never tagged for the native reveal, and native code is told which tabs those are", async () => {
  const { tabPressTag, PAGE_IDENTITY_TAG } = await import("./tabReveal.ts");
  assert.equal(tabPressTag("a", false, false), "tab-switch:a");
  assert.equal(tabPressTag("a", true, false), "tab-selected:a");
  assert.equal(tabPressTag("a", false, true), undefined);
  assert.equal(PAGE_IDENTITY_TAG, "page-identity");
  setup();
  stub.nativeTabPresses.splits.length = 0;
  const id = S().createSplit(["b", "c"]);
  assert.deepEqual([...stub.nativeTabPresses.splits.at(-1)].sort(), ["b", "c"]);
  S().separateSplit?.(id);
});

test("the native switch is off while a page popover is open: it names the page under it", async () => {
  const { setPopover } = await import("./pageState.ts");
  setup();
  stub.nativeTabSwitches.length = 0;
  setPopover("a", "siteControls");
  setPopover("a", null);
  assert.deepEqual(stub.nativeTabSwitches, [false, true]);
});
