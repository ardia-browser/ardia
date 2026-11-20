import assert from "node:assert/strict";
import test from "node:test";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const windowsChrome = (await import("../../browser/src/lib/platformChrome.windows.ts")).WINDOW_CHROME;

function state(settings = {}, window = {}, extra = {}) {
  return {
    windows: { w: { id: "w", kind: "main", profileId: "p", fullScreen: false, ...window } },
    windowOrder: ["w"], ui: { focusOrder: ["w"] }, profiles: { p: { id: "p", name: "Personal" } }, profileOrder: ["p"], downloads: [], windowUi: {},
    ...extra,
    settings: { pageFrame: 9, tabLayout: "sidebar", sidebarSide: "left", addressBar: "toolbar", compactToolbar: false, hideToolbarWhileScrolling: false, autoHideTabs: false, sidebarWidth: 190, ...settings },
  };
}

test("Linux lays out its window with the Windows build's chrome", async () => {
  const linux = (await import("../../browser/src/lib/platformChrome.linux.ts")).WINDOW_CHROME;
  assert.equal(linux, windowsChrome);
});

test("minimize and maximize reach the Linux host's window calls; caption regions are the shell's own drag regions", async () => {
  const calls = [];
  globalThis.window = { __ardiaHost: { bootstrap: { windowId: "main", profileId: "default" }, invoke: async (method, args) => void calls.push([method, args.args]), onEvent: () => () => {} } };
  const { windowControls } = await import("./hostWindowControls.ts");
  windowControls.minimize("main");
  windowControls.toggleMaximize("main");
  windowControls.setCaptionRegions("main", [[0, 0, 100, 32]]);
  await settle();
  assert.deepEqual(calls, [["ArdiaShell.minimizeWindow", ["main"]], ["ArdiaShell.toggleMaximizeWindow", ["main"]]]);
});

test("one click on Close shows one confirmation through Linux's own close coordinator, and Cancel keeps the window open", async () => {
  const { useBrowser } = await import("../../browser/src/state/browser/store.ts");
  const { createWindowCloseBarrier } = await import("./utilityClose.ts");
  const { createWindowCloseCoordinator } = await import("./windowCloseCoordinator.ts");
  const { decideLinuxWindowClose } = await import("./windowCloseDecider.ts");
  const stub = await import("../../browser/src/test-native/index.ts");
  const S = () => useBrowser.getState();
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  S().updateSettings({ warnBeforeClosingWindow: true });
  S().createWindow({ url: "https://staying.ardia.test/" });
  const leaving = S().createWindow({ url: "https://one.ardia.test/" });
  S().newTab(leaving, { url: "https://two.ardia.test/" });
  const asked = [];
  const drained = [];
  let answer = { confirmed: false, suppressed: false };
  let generation = 0;
  let coordinator;
  const barrier = createWindowCloseBarrier({
    quiesce: () => {},
    drain: async () => 0,
    acknowledge: async (value) => void drained.push(value.closeGeneration),
    reject: async () => {},
    resume: (value) => coordinator.producersResumed(value),
  });
  coordinator = createWindowCloseCoordinator({
    windowId: leaving,
    utility: false,
    decide: decideLinuxWindowClose,
    ask: async (options) => (asked.push(options.title), answer),
    suppress: () => {},
    flush: async () => {},
    request: async () => ({ windowId: leaving, rendererGeneration: "1", closeGeneration: String(++generation) }),
    beginDrain: async () => ({ accepted: true, endsSession: false }),
    reject: async () => {},
    barrier,
    cancelled: barrier.cancelled,
  });
  const previous = stub.shellNativeModules.ArdiaAppWindows.closeWindow;
  stub.shellNativeModules.ArdiaAppWindows.closeWindow = (id) => coordinator.closeWindow(id);
  const until = async (done) => { for (let i = 0; i < 50 && !done(); i++) await settle(); };
  try {
    const { closeFromWindowControls } = await import("./captionControls.ts");
    closeFromWindowControls(leaving);
    await until(() => asked.length === 1);
    await settle();
    assert.deepEqual(asked, ["Close 2 tabs?"]);
    assert.deepEqual(drained, [], "Cancel drains nothing");
    assert.ok(S().windows[leaving], "and the window stays");
    answer = { confirmed: true, suppressed: false };
    closeFromWindowControls(leaving);
    await until(() => drained.length === 1);
    assert.deepEqual(asked, ["Close 2 tabs?", "Close 2 tabs?"], "one confirmation per click");
    assert.equal(drained.length, 1);
  } finally {
    stub.shellNativeModules.ArdiaAppWindows.closeWindow = previous;
  }
});

test("never two menu buttons with F11 full screen: the … while the window buttons are placed, otherwise the header's hamburger, whose header Linux never collapses", async () => {
  const { menuBesideWindowButtons, linuxSidebarHeaderCollapsed, linuxDownloadsInSidebarFooter, sidebarHeaderCollapsed } = await import("./sidebarHeaderLayout.ts");
  const layouts = [{}, { compactToolbar: true }, { addressBar: "sidebar" }, { sidebarSide: "right" }, { addressBar: "sidebar", sidebarSide: "right" }, { tabLayout: "top" }, { autoHideTabs: true }, { minimalismMode: true }];
  for (const settings of layouts) {
    assert.equal(menuBesideWindowButtons(state(settings), "w", false, windowsChrome), true, JSON.stringify(settings));
    assert.equal(menuBesideWindowButtons(state(settings, { fullScreen: true }), "w", false, windowsChrome), false, JSON.stringify(settings));
    assert.equal(linuxSidebarHeaderCollapsed(state(settings, { fullScreen: true }), "w", false, windowsChrome), false, JSON.stringify(settings));
  }
  assert.equal(menuBesideWindowButtons(state({}, { kind: "small" }), "w", false, windowsChrome), true, "Little Ardia's bar holds it");
  const fullScreen = state({}, { fullScreen: true });
  assert.equal(sidebarHeaderCollapsed(fullScreen, "w", windowsChrome), true, "the Windows rule hides the header in full screen");
  assert.equal(linuxSidebarHeaderCollapsed(state(), "w", false, windowsChrome), true, "with the menu beside the buttons the header collapses as on Windows");
  assert.equal(linuxDownloadsInSidebarFooter(state(), "w", false, windowsChrome), true);
  assert.equal(linuxDownloadsInSidebarFooter(fullScreen, "w", false, windowsChrome), false);
});

test("a page in full screen, which leaves the window itself out of full screen, hides the window buttons and brings back the header with its hamburger", async () => {
  const { menuBesideWindowButtons, linuxSidebarHeaderCollapsed, linuxDownloadsInSidebarFooter, windowControlsPlace, pageFrameIn } = await import("./sidebarHeaderLayout.ts");
  const { linuxControlsBehaviour } = await import("./windowControlsRules.ts");
  const s = state();
  assert.notEqual(windowControlsPlace(s, "w", pageFrameIn(s, "w"), windowsChrome), null, "the shared layout still places the buttons");
  assert.equal(linuxControlsBehaviour({ pageFullScreen: true, hidden: false, utility: false, windowMenu: true }).rendered, false, "but the wrapper draws none");
  assert.equal(menuBesideWindowButtons(s, "w", true, windowsChrome), false);
  assert.equal(linuxSidebarHeaderCollapsed(s, "w", true, windowsChrome), false);
  assert.equal(linuxDownloadsInSidebarFooter(s, "w", true, windowsChrome), false);
  for (const settings of [{ addressBar: "sidebar" }, { sidebarSide: "right" }, { tabLayout: "top" }]) assert.equal(menuBesideWindowButtons(state(settings), "w", true, windowsChrome), false, JSON.stringify(settings));
});

test("with a page full screen and the sidebar on the right, the returning hamburger gets the header's room, not 2 px beside buttons that aren't drawn", async () => {
  const { linuxSidebarCaptionRoom, sidebarCaptionRoom } = await import("./sidebarHeaderLayout.ts");
  const { headerIndicatorLayout } = await import("./profileIndicatorLayout.ts");
  const { CARD_INSET } = await import("../../browser/src/lib/windowLayout.ts");
  const { space } = await import("../../browser/src/components/ui/tokens.ts");
  const right = state({ sidebarSide: "right" });
  const headerRoom = (captionRoom) => 190 - Math.max(windowsChrome.leadingWidth + 6, CARD_INSET) - space.m - captionRoom;
  assert.equal(sidebarCaptionRoom(right, "w", windowsChrome), windowsChrome.trailingWidth, "the shared rule still reserves the buttons' room");
  assert.ok(headerRoom(sidebarCaptionRoom(right, "w", windowsChrome)) < 32, "which would clip the hamburger");
  assert.equal(linuxSidebarCaptionRoom(right, "w", true, windowsChrome), 0);
  const room = headerRoom(linuxSidebarCaptionRoom(right, "w", true, windowsChrome));
  assert.deepEqual([headerIndicatorLayout({ room, textWidth: undefined, named: false, menuInHeader: true }).width, room >= 32], [32, true]);
  assert.equal(linuxSidebarCaptionRoom(right, "w", false, windowsChrome), windowsChrome.trailingWidth, "while the buttons are drawn their room stays reserved");
  assert.equal(linuxSidebarCaptionRoom(state({ sidebarSide: "right" }, { fullScreen: true }), "w", false, windowsChrome), 0);
});

test("the header's profile name makes room for the menu only when the header holds it", async () => {
  const { headerIndicatorLayout } = await import("./profileIndicatorLayout.ts");
  const layout = (room, named, menuInHeader) => headerIndicatorLayout({ room, textWidth: 60, named, menuInHeader });
  assert.equal(layout(120, false, true).width, 32);
  assert.equal(layout(120, false, false).width, 0);
  assert.equal(layout(120, true, true).width, 104);
  assert.equal(layout(120, true, false).width, 70);
  assert.equal(layout(40, true, true).shown, false);
  assert.equal(layout(40, true, false).shown, true);
});

test("the sidebar's header tools hold no profile name: back, forward and reload sit at the right edge as on the Mac, and the full-screen menu takes reload's slot", async () => {
  const { sidebarHeaderSplit } = await import("./profileIndicatorLayout.ts");
  const slot = { edge: 10, button: 30, pitch: 35 };
  const split = (width, captionRoom, menuInHeader = false) => sidebarHeaderSplit({ width, captionRoom, controls: 141, toggleOnly: 45, menuInHeader, slot });
  assert.deepEqual(split(277, 0), { tools: true, navigation: 277, menuLeft: 0 }, "a left sidebar with the address bar: the buttons end at the sidebar's edge");
  assert.deepEqual(split(190, 0), { tools: true, navigation: 190, menuLeft: 0 });
  assert.deepEqual(split(260, 171), { tools: true, navigation: 89, menuLeft: 0 }, "a right sidebar stops them short of the window buttons");
  assert.deepEqual(split(190, 171), { tools: true, navigation: 19, menuLeft: 0 }, "the toggle still fits left of the window buttons at 190 px");
  assert.deepEqual(split(160, 171), { tools: false, navigation: 0, menuLeft: 0 }, "at the 160 px minimum the toggle would sit under the …, so the header tools give way");
  const fullScreen = split(277, 0, true);
  assert.deepEqual(fullScreen, { tools: true, navigation: 242, menuLeft: 236 }, "in full screen the menu sits where reload would, one pitch right of it");
  assert.equal(fullScreen.navigation - slot.edge - slot.button / 2 + slot.pitch, fullScreen.menuLeft + 16);
  const narrowest = split(160, 0, true);
  assert.deepEqual(narrowest, { tools: true, navigation: 125, menuLeft: 119 }, "at the 160 px minimum the menu still sits at the edge");
  assert.ok(narrowest.navigation - slot.edge - slot.button / 2 + 16 <= narrowest.menuLeft, "and clears the last navigation button's plate");
  assert.deepEqual(split(60, 0, true),{ tools: true, navigation: 45, menuLeft: 45 }, "a sidebar too narrow for the buttons keeps the menu clear of the toggle");
});

function clusterHarness() {
  const listeners = {};
  let open = false;
  const opened = [];
  let dismissed = 0;
  const menuButton = { name: "…", isConnected: true, closest: (selector) => (selector === '[role="button"][aria-label="Menu"]' ? menuButton : null) };
  const detached = { name: "detached …", isConnected: false, closest: (selector) => (selector === '[role="button"][aria-label="Menu"]' ? detached : null) };
  const element = (name) => ({ name, closest: () => null });
  const reload = element("Reload");
  const field = element("address field");
  let focused = null;
  return {
    async load() {
      const { createClusterMenu } = await import("./clusterMenu.ts");
      this.show = createClusterMenu({
        target: { addEventListener: (type, listener, capture) => capture && (listeners[type] = listener) },
        open: async (windowId, anchor) => void opened.push(anchor.name),
        shown: () => open,
        dismiss: () => { dismissed++; open = false; },
        focused: () => focused,
        visible: () => menuButton,
      });
    },
    press: (target, button = 0) => listeners.pointerdown({ button, target }),
    key: (key) => listeners.keydown({ key }),
    focus: (target) => void (focused = target),
    setOpen: (value) => void (open = value),
    dismissed: () => dismissed,
    menuButton, detached, reload, field, opened,
  };
}

test("the … opens Linux's full app menu under itself, and a second press while it's open closes it instead of reopening", async () => {
  const h = clusterHarness();
  await h.load();
  h.press(h.menuButton);
  await h.show("w");
  assert.deepEqual(h.opened, ["…"]);
  h.setOpen(true);
  h.press(h.menuButton);
  h.setOpen(false);
  await h.show("w");
  assert.deepEqual(h.opened, ["…"]);
});

test("Enter on the focused … while its menu is open closes the menu, as the header's hamburger does", async () => {
  const h = clusterHarness();
  await h.load();
  h.setOpen(true);
  h.focus(h.menuButton);
  h.key("Enter");
  await h.show("w");
  assert.deepEqual(h.opened, []);
  assert.equal(h.dismissed(), 1);
  h.key("Enter");
  await h.show("w");
  assert.deepEqual(h.opened, ["…"]);
});

test("a click elsewhere never steers the … menu: after clicking Reload, Tab and Enter on the … anchor it to the …", async () => {
  const h = clusterHarness();
  await h.load();
  h.press(h.reload);
  h.focus(h.menuButton);
  h.key("Enter");
  await h.show("w");
  assert.deepEqual(h.opened, ["…"]);
});

test("activated with no press or key, as assistive technology does, the menu anchors to the visible …, not to whatever has focus", async () => {
  const h = clusterHarness();
  await h.load();
  h.focus(h.field);
  await h.show("w");
  assert.deepEqual(h.opened, ["…"]);
});

test("after a menu is dismissed by clicking outside, keyboard activation of the … opens it on the first press", async () => {
  const h = clusterHarness();
  await h.load();
  h.setOpen(true);
  h.press(h.reload);
  h.setOpen(false);
  h.focus(h.menuButton);
  h.key(" ");
  await h.show("w");
  assert.deepEqual(h.opened, ["…"]);
});

test("a press on the … that never activated it, like a drag off the button, doesn't stop the next Enter from opening the menu", async () => {
  const h = clusterHarness();
  await h.load();
  h.setOpen(true);
  h.press(h.menuButton);
  h.setOpen(false);
  h.focus(h.menuButton);
  h.key("Enter");
  await h.show("w");
  assert.deepEqual(h.opened, ["…"]);
});

test("a press outside while a menu was open is forgotten even when the … is then activated without a key", async () => {
  const h = clusterHarness();
  await h.load();
  h.setOpen(true);
  h.press(h.reload);
  h.setOpen(false);
  await h.show("w");
  assert.deepEqual(h.opened, ["…"]);
});

function maximizedHarness(windowId, frameOf) {
  let resize;
  const frames = [];
  const noted = [];
  const replies = [];
  const host = { bootstrap: { windowId, profileId: "default" }, invoke: (method, args) => new Promise((resolve) => replies.push(() => resolve(method === "ArdiaShell.windowFrame" && args.args[0] === windowId ? frameOf() : "wrong"))), onEvent: () => () => {} };
  const shell = {
    screen: { availWidth: 1440, availHeight: 870 }, outerWidth: 900, outerHeight: 700,
    addEventListener: (type, listener) => type === "resize" && (resize = listener),
    requestAnimationFrame: (callback) => frames.push(callback),
  };
  return { host, shell, noted, replies, resize: () => resize(), frame: () => frames.splice(0).forEach((callback) => callback()) };
}

test("maximize turns into restore from the window's frame, read again once per animation frame of resizing, in browser windows and Settings alike", async () => {
  const { followWindowMaximized } = await import("./windowMaximized.ts");
  for (const windowId of ["w", "settings"]) {
    let frame = [80, 60, 900, 700];
    const h = maximizedHarness(windowId, () => frame);
    followWindowMaximized(h.host, windowId, h.shell, (id, on) => h.noted.push([id, on]));
    await settle();
    h.replies.shift()();
    await settle();
    frame = [0, 30, 1440, 870];
    h.resize();
    h.resize();
    h.resize();
    h.frame();
    await settle();
    assert.equal(h.replies.length, 1, "three resizes in one frame read the frame once");
    h.resize();
    h.frame();
    await settle();
    const stale = h.replies.shift();
    h.replies.shift()();
    await settle();
    stale();
    await settle();
    assert.deepEqual(h.noted, [[windowId, false], [windowId, true]], "an older read never overrides a newer one");
  }
});

test("without a frame, as on Wayland, the shell's outer size is compared with the screen; this test's fake screen has no panel, so outer equal to avail reads as maximized", async () => {
  const { followWindowMaximized } = await import("./windowMaximized.ts");
  const h = maximizedHarness("w", () => null);
  followWindowMaximized(h.host, "w", h.shell, (id, on) => h.noted.push([id, on]));
  await settle();
  h.replies.shift()();
  await settle();
  h.shell.outerWidth = 1440;
  h.shell.outerHeight = 870;
  h.resize();
  h.frame();
  await settle();
  h.replies.shift()();
  await settle();
  assert.deepEqual(h.noted, [["w", false], ["w", true]]);
});

test("the Linux wrapper hides the buttons over a full-screen page, makes the hidden copy inert, and offers the window menu only in browser windows", async () => {
  const { linuxControlsBehaviour } = await import("./windowControlsRules.ts");
  const base = { pageFullScreen: false, hidden: false, utility: false, windowMenu: true };
  assert.deepEqual(linuxControlsBehaviour(base), { rendered: true, inert: false, windowMenuOnRightClick: true });
  assert.equal(linuxControlsBehaviour({ ...base, pageFullScreen: true }).rendered, false);
  assert.equal(linuxControlsBehaviour({ ...base, hidden: true }).inert, true);
  assert.equal(linuxControlsBehaviour({ ...base, utility: true }).windowMenuOnRightClick, false, "Settings and Import");
  assert.equal(linuxControlsBehaviour({ ...base, windowMenu: false }).windowMenuOnRightClick, false);
});

test("a primary-button press on a window button leaves focus where it was; other buttons and other targets are untouched", async () => {
  const { pressKeepsFocusWhereItWas } = await import("./windowControlsRules.ts");
  const button = { closest: (selector) => (selector === '[role="button"]' ? {} : null) };
  const gap = { closest: () => null };
  assert.equal(pressKeepsFocusWhereItWas({ button: 0, target: button }), true);
  assert.equal(pressKeepsFocusWhereItWas({ button: 2, target: button }), false);
  assert.equal(pressKeepsFocusWhereItWas({ button: 0, target: gap }), false);
  assert.equal(pressKeepsFocusWhereItWas({ button: 0, target: null }), false);
});

test("a right or middle press on the … neither anchors nor toggles its menu", async () => {
  const h = clusterHarness();
  await h.load();
  h.press(h.menuButton, 2);
  h.focus(h.field);
  h.setOpen(true);
  h.setOpen(false);
  await h.show("w");
  assert.deepEqual(h.opened, ["…"]);
  h.setOpen(true);
  h.press(h.menuButton, 1);
  h.setOpen(false);
  await h.show("w");
  assert.deepEqual(h.opened, ["…", "…"], "a middle press while a menu was open doesn't swallow the next activation");
});

test("a press on a … that was swapped out before activation, like the toolbar row's copy giving way to the strip's, anchors to the visible …", async () => {
  const h = clusterHarness();
  await h.load();
  h.focus(h.field);
  h.press(h.detached);
  await h.show("w");
  assert.deepEqual(h.opened, ["…"]);
});

test("a right or middle press forgets an earlier press on the …, so the next activation without a key opens the menu", async () => {
  const h = clusterHarness();
  await h.load();
  h.setOpen(true);
  h.press(h.menuButton);
  h.setOpen(false);
  h.press(h.reload, 2);
  await h.show("w");
  assert.deepEqual(h.opened, ["…"]);
});

test("in a narrow right sidebar the Downloads button leaves the header for the footer instead of sliding under the window buttons", async () => {
  const { headerFitsDownloads, linuxDownloadsInSidebarFooter } = await import("./sidebarHeaderLayout.ts");
  const right = (sidebarWidth, window) => state({ sidebarSide: "right", sidebarWidth }, window);
  assert.equal(headerFitsDownloads(right(160), "w", false, windowsChrome), false, "at 160 px the cluster starts at 19, over the button at 9–43");
  assert.equal(linuxDownloadsInSidebarFooter(right(160), "w", false, windowsChrome), true);
  assert.equal(headerFitsDownloads(right(190), "w", false, windowsChrome), true);
  assert.equal(linuxDownloadsInSidebarFooter(right(190), "w", false, windowsChrome), false, "at 190 px it stays in the header");
  assert.equal(headerFitsDownloads(right(160), "w", true, windowsChrome), true, "with a page full screen the buttons aren't drawn");
  assert.equal(headerFitsDownloads(right(160, { fullScreen: true }), "w", false, windowsChrome), true);
  assert.equal(headerFitsDownloads(state({ sidebarWidth: 160 }), "w", false, windowsChrome), true, "a left sidebar's header has no buttons in it");
});
