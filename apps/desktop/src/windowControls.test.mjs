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

test("Linux lays out its window with the Windows build's chrome until Traffic lights is chosen", async () => {
  const linux = (await import("../../browser/src/lib/platformChrome.desktop.ts")).WINDOW_CHROME;
  assert.deepEqual(linux, windowsChrome);
});

test("the traffic lights show only when chosen, and hide while the window or a page is full screen, as the Mac's do", async () => {
  const { trafficLightsShown } = await import("./windowControlsRules.ts");
  const shown = (style, pageFullScreen = false, windowFullScreen = false) => trafficLightsShown({ style, pageFullScreen, windowFullScreen });
  assert.equal(shown("trafficLights"), true);
  assert.equal(shown("native"), false);
  assert.equal(shown("hidden"), false);
  assert.equal(shown("trafficLights", true), false);
  assert.equal(shown("trafficLights", false, true), false);
});

test("with the traffic lights every layout keeps the header's hamburger, never collapses the header and keeps Downloads in it", async () => {
  const { menuBesideWindowButtons, linuxSidebarCaptionRoom, linuxSidebarHeaderCollapsed, linuxDownloadsInSidebarFooter, headerFitsDownloads, addressBarInSidebar } = await import("./sidebarHeaderLayout.ts");
  const { TRAFFIC_LIGHTS_CHROME } = await import("../../browser/src/lib/platformChrome.desktop.ts");
  const layouts = [{}, { compactToolbar: true }, { sidebarSide: "right" }, { sidebarSide: "right", sidebarWidth: 160 }, { tabLayout: "top" }, { autoHideTabs: true }, { minimalismMode: true }];
  for (const settings of layouts) {
    for (const window of [{}, { fullScreen: true }, { kind: "small" }]) {
      const s = state(settings, window);
      const label = JSON.stringify([settings, window]);
      assert.equal(menuBesideWindowButtons(s, "w", false, TRAFFIC_LIGHTS_CHROME), false, label);
      assert.equal(linuxSidebarCaptionRoom(s, "w", false, TRAFFIC_LIGHTS_CHROME), 0, label);
      assert.equal(linuxSidebarHeaderCollapsed(s, "w", false, TRAFFIC_LIGHTS_CHROME), false, label);
      assert.equal(headerFitsDownloads(s, "w", false, TRAFFIC_LIGHTS_CHROME), true, label);
    }
    assert.equal(linuxDownloadsInSidebarFooter(state(settings), "w", false, TRAFFIC_LIGHTS_CHROME), !!addressBarInSidebar(state(settings), "w"), JSON.stringify(settings));
  }
});

test("with the window buttons hidden every layout keeps the header's hamburger and keeps no room for buttons, so a tiling window manager's window still has its menu", async () => {
  const { menuBesideWindowButtons, linuxSidebarCaptionRoom, linuxSidebarHeaderCollapsed, linuxDownloadsInSidebarFooter, headerFitsDownloads, addressBarInSidebar } = await import("./sidebarHeaderLayout.ts");
  const { HIDDEN_BUTTONS_CHROME } = await import("../../browser/src/lib/platformChrome.desktop.ts");
  const layouts = [{}, { compactToolbar: true }, { sidebarSide: "right" }, { sidebarSide: "right", sidebarWidth: 160 }, { tabLayout: "top" }, { autoHideTabs: true }, { minimalismMode: true }, { addressBar: "sidebar" }];
  for (const settings of layouts) {
    for (const window of [{}, { fullScreen: true }, { kind: "small" }]) {
      const s = state(settings, window);
      const label = JSON.stringify([settings, window]);
      assert.equal(menuBesideWindowButtons(s, "w", false, HIDDEN_BUTTONS_CHROME), false, label);
      assert.equal(linuxSidebarCaptionRoom(s, "w", false, HIDDEN_BUTTONS_CHROME), 0, label);
      assert.equal(linuxSidebarHeaderCollapsed(s, "w", false, HIDDEN_BUTTONS_CHROME), false, label);
      assert.equal(headerFitsDownloads(s, "w", false, HIDDEN_BUTTONS_CHROME), true, label);
    }
    assert.equal(linuxDownloadsInSidebarFooter(state(settings), "w", false, HIDDEN_BUTTONS_CHROME), !!addressBarInSidebar(state(settings), "w"), JSON.stringify(settings));
  }
});

test("with the traffic lights or the buttons hidden a hamburger is drawn even where Minimalism or the theme hides the profile, and in Little Ardia's bar; the native buttons keep it beside them", async () => {
  const { readFileSync } = await import("node:fs");
  const { registerHooks } = await import("node:module");
  const indicatorUrl = new URL("./ProfileIndicator.tsx", import.meta.url).href;
  const fakes = new Map([
    ["@ardia/shell", "export const Symbol = () => null;"],
    ["./AppMenuButton", "export function AppMenuButton() { return null; }"],
  ]);
  registerHooks({
    resolve: (specifier, context, next) => context.parentURL === indicatorUrl && fakes.has(specifier) ? { url: `data:text/javascript,${encodeURIComponent(fakes.get(specifier))}`, shortCircuit: true } : next(specifier, context),
  });
  const { mount } = await import("../../browser/src/test-hooks.mjs");
  const { useBrowser } = await import("../../browser/src/state/browser/store.ts");
  const { WindowContext } = await import("../../browser/src/state/browser/hooks.ts");
  const { WINDOW_CHROME } = await import("../../browser/src/lib/windowChrome.ts");
  const { TRAFFIC_LIGHTS_CHROME, HIDDEN_BUTTONS_CHROME } = await import("../../browser/src/lib/platformChrome.desktop.ts");
  const { HeaderAppMenu, ProfileIndicator } = await import("./ProfileIndicator.tsx");
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const sidebar = source("../../browser/src/components/sidebar/Sidebar.tsx");
  const strip = source("../../browser/src/components/tabstrip/TopTabStrip.tsx");
  assert.match(sidebar, /\n\s*<ProfileIndicator room=\{[^\n]*\} profileShown=\{profileShown\} \/>/, "the sidebar header always mounts the indicator");
  assert.doesNotMatch(sidebar, /profileShown \? <ProfileIndicator/);
  assert.match(strip, /<ProfileIndicator room=\{PROFILE_ROOM\} profileShown=\{!minimal\} \/>/, "the top strip mounts it under Minimalism too");
  assert.match(strip, /useProfileIndicatorWidth\(PROFILE_ROOM, !minimal\)/);
  assert.match(strip, /const controls = minimal \? profileChip :/);
  const little = source("../../browser/src/components/littleArdia/LittleArdiaWindow.tsx");
  assert.match(little, /const appMenu = useAppMenuInHeader\(\);/);
  assert.match(little, /\.\.\.\(appMenu \? \[<HeaderAppMenu key="menu" size=\{SMALL_BAR_BUTTON\} \/>\] : \[\]\)/, "Little Ardia's bar holds the hamburger");
  const inWindowMenu = (process.env.ARDIA_DESKTOP_MODE ?? "linux") === "mac" ? 0 : 1;
  const S = () => useBrowser.getState();
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  const windowId = S().createWindow({ url: "https://menu.ardia.test/" });
  const saved = { ...WINDOW_CHROME };
  const menuButtons = (node) => !node || typeof node !== "object" ? 0 : Array.isArray(node) ? node.reduce((sum, child) => sum + menuButtons(child), 0) : (node.type?.name === "AppMenuButton" ? 1 : 0) + menuButtons(node.props?.children);
  const menus = (profileShown) => {
    const mounted = mount(() => ProfileIndicator({ room: 160, profileShown }), { contexts: [[WindowContext, windowId]] });
    try {
      return menuButtons(mounted.value);
    } finally {
      mounted.unmount();
    }
  };
  try {
    for (const settings of [{ tabLayout: "top", minimalismMode: true }, { tabLayout: "sidebar", minimalismMode: false }, { tabLayout: "sidebar", sidebarSide: "right", minimalismMode: false }]) {
      S().updateSettings(settings);
      for (const [name, chrome] of [["trafficLights", TRAFFIC_LIGHTS_CHROME], ["hidden", HIDDEN_BUTTONS_CHROME]]) {
        Object.assign(WINDOW_CHROME, chrome);
        const label = JSON.stringify([settings, name]);
        assert.equal(menus(false), inWindowMenu, `profile hidden: ${label}`);
        assert.equal(menus(true), inWindowMenu, `profile shown: ${label}`);
      }
      Object.assign(WINDOW_CHROME, windowsChrome);
      assert.equal(menus(false), 0, `native: ${JSON.stringify(settings)}`);
    }
    const little = S().createWindow({ kind: "small", url: "https://little.ardia.test/" });
    const barMenus = () => {
      const mounted = mount(() => HeaderAppMenu({ size: 28 }), { contexts: [[WindowContext, little]] });
      try {
        return menuButtons(mounted.value);
      } finally {
        mounted.unmount();
      }
    };
    for (const [name, chrome] of [["trafficLights", TRAFFIC_LIGHTS_CHROME], ["hidden", HIDDEN_BUTTONS_CHROME]]) {
      Object.assign(WINDOW_CHROME, chrome);
      assert.equal(barMenus(), inWindowMenu, `Little Ardia: ${name}`);
    }
    Object.assign(WINDOW_CHROME, windowsChrome);
    assert.equal(barMenus(), 0, "Little Ardia: native keeps the menu beside its buttons");
  } finally {
    Object.assign(WINDOW_CHROME, saved);
  }
});

test("the header's empty room beside the hamburger drags the window: the profile controls pass presses through except on their buttons", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const rule = (selector) => new RegExp(`(^|\\n)${selector.replace(/[.>]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`).exec(css)?.[2] ?? "";
  assert.match(rule(".ardia-profile-controls"), /pointer-events: none;/);
  assert.match(rule(".ardia-profile-controls > .ardia-header-button"), /pointer-events: auto;/);
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

test("an engine that reports window state drives restore from its maximized flag, read at start and followed by its event, in browser windows and Settings alike; the frame isn't read", async () => {
  const { followWindowMaximized, WINDOW_STATE_METHOD } = await import("./windowMaximized.ts");
  for (const windowId of ["w", "settings"]) {
    const listeners = new Set();
    const invoked = [];
    let answer;
    const host = {
      bootstrap: { windowId, profileId: "default", capabilities: [WINDOW_STATE_METHOD] },
      invoke: (method, args) => (invoked.push([method, args]), new Promise((resolve) => (answer = resolve))),
      onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    };
    const emit = (module, event, payload) => listeners.forEach((listener) => listener(module, event, payload));
    const noted = [];
    let resized = false;
    const shell = { screen: { availWidth: 1440, availHeight: 870 }, outerWidth: 1440, outerHeight: 870, addEventListener: () => (resized = true), requestAnimationFrame: () => 0 };
    followWindowMaximized(host, windowId, shell, (id, on) => noted.push([id, on]));
    await settle();
    answer({ maximized: false, tiled: true, fullScreen: false });
    await settle();
    emit("ArdiaShell", "windowState", { windowId, maximized: true, tiled: true, fullScreen: false });
    emit("ArdiaShell", "windowState", { windowId: "other", maximized: false, tiled: false, fullScreen: false });
    emit("ArdiaTabs", "windowState", { windowId, maximized: false });
    emit("ArdiaShell", "windowState", { windowId, maximized: "yes" });
    emit("ArdiaShell", "windowState", { windowId, maximized: false, tiled: false, fullScreen: true });
    assert.deepEqual(invoked, [[WINDOW_STATE_METHOD, { args: [windowId] }]], "a half tile that fills the screen is no longer guessed from its frame");
    assert.equal(resized, false);
    assert.deepEqual(noted, [[windowId, false], [windowId, true], [windowId, false]]);
  }
});

test("a window-state event heard before the first read answers isn't undone by that read", async () => {
  const { followWindowMaximized, WINDOW_STATE_METHOD, reportedMaximized } = await import("./windowMaximized.ts");
  const listeners = new Set();
  let answer;
  const host = { bootstrap: { windowId: "w", profileId: "default", capabilities: [WINDOW_STATE_METHOD] }, invoke: () => new Promise((resolve) => (answer = resolve)), onEvent: (listener) => (listeners.add(listener), () => {}) };
  const noted = [];
  followWindowMaximized(host, "w", null, (id, on) => noted.push([id, on]));
  listeners.forEach((listener) => listener("ArdiaShell", "windowState", { windowId: "w", maximized: true, tiled: false, fullScreen: false }));
  await settle();
  answer({ maximized: false, tiled: false, fullScreen: false });
  await settle();
  assert.deepEqual(noted, [["w", true]]);
  for (const payload of [undefined, null, {}, { maximized: 1 }, "maximized"]) assert.equal(reportedMaximized(payload), undefined);
});

test("the Linux wrapper hides the buttons over a full-screen page, makes the hidden copy inert, and offers the window menu only in browser windows", async () => {
  const { linuxControlsBehaviour } = await import("./windowControlsRules.ts");
  const base = { pageFullScreen: false, hidden: false, utility: false, windowMenu: true, shown: true };
  assert.deepEqual(linuxControlsBehaviour(base), { rendered: true, inert: false, takesInput: true, windowMenuOnRightClick: true });
  assert.equal(linuxControlsBehaviour({ ...base, pageFullScreen: true }).rendered, false);
  assert.equal(linuxControlsBehaviour({ ...base, hidden: true }).inert, true);
  assert.equal(linuxControlsBehaviour({ ...base, utility: true }).windowMenuOnRightClick, false, "Settings and Import");
  assert.equal(linuxControlsBehaviour({ ...base, windowMenu: false }).windowMenuOnRightClick, false);
});

test("the wrapper's input region follows the live window-button style, so buttons drawn by a live switch to Native take input and none is left behind by a switch away", async () => {
  const { readFileSync } = await import("node:fs");
  const { linuxControlsBehaviour } = await import("./windowControlsRules.ts");
  const base = { pageFullScreen: false, hidden: false, utility: false, windowMenu: true, shown: true };
  assert.equal(linuxControlsBehaviour(base).takesInput, true);
  assert.equal(linuxControlsBehaviour({ ...base, shown: false }).takesInput, false, "Traffic lights and Hidden draw no buttons");
  assert.equal(linuxControlsBehaviour({ ...base, hidden: true }).takesInput, false);
  assert.equal(linuxControlsBehaviour({ ...base, pageFullScreen: true }).takesInput, false);
  const wrapper = readFileSync(new URL("./WindowControls.tsx", import.meta.url), "utf8");
  assert.match(wrapper, /shown: useControlsShown\(\)/);
  assert.match(wrapper, /\}, \[behaviour\.takesInput\]\);/);
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

test("a primary press on a traffic light leaves keyboard focus where it was, and lights slid off the window can't be reached with Tab", async () => {
  const { readFileSync } = await import("node:fs");
  const { lightPressKeepsFocusWhereItWas } = await import("./windowControlsRules.ts");
  const { trafficLightsOffWindow } = await import("./shims/web/windowChrome.tsx");
  const light = { closest: (selector) => (selector === ".ardia-window-control" ? {} : null) };
  const caption = { closest: (selector) => (selector === '[role="button"]' ? {} : null) };
  assert.equal(lightPressKeepsFocusWhereItWas({ button: 0, target: light }), true);
  assert.equal(lightPressKeepsFocusWhereItWas({ button: 2, target: light }), false, "a right press still opens the window menu");
  assert.equal(lightPressKeepsFocusWhereItWas({ button: 0, target: caption }), false);
  assert.equal(lightPressKeepsFocusWhereItWas({ button: 0, target: null }), false);
  assert.equal(trafficLightsOffWindow({ center: [25, 27], trailing: false }), false);
  assert.equal(trafficLightsOffWindow({ center: [-165, 27], trailing: false }), true, "a hidden left sidebar takes its lights with it");
  assert.equal(trafficLightsOffWindow({ center: [25, 27], trailing: true }), false);
  assert.equal(trafficLightsOffWindow({ center: [-40, 27], trailing: true }), true, "and a hidden right sidebar too");
  const lights = readFileSync(new URL("./TrafficLights.tsx", import.meta.url), "utf8");
  assert.match(lights, /inert=\{trafficLightsOffWindow\(place\) \|\| undefined\}/);
  assert.match(lights, /onMouseDown=\{\(e\) => \{\n\s*if \(lightPressKeepsFocusWhereItWas\(e\)\) e\.preventDefault\(\);/);
});

test("pressing a header menu button leaves focus where it was, so a later key press never rings the button the pointer opened", async () => {
  const { readFileSync } = await import("node:fs");
  const menuButton = readFileSync(new URL("./AppMenuButton.tsx", import.meta.url), "utf8");
  const indicator = readFileSync(new URL("./ProfileIndicator.tsx", import.meta.url), "utf8");
  assert.match(menuButton, /className="ardia-header-button ardia-app-menu-button"[\s\S]*onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(indicator, /className="ardia-header-button ardia-current-space"[^\n]*onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.doesNotMatch(menuButton + indicator, /\.blur\(\)/, "no button is blurred after its menu closes: a pointer never focused it, and a keyboard user keeps their place");
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

test("whatever the desktop's layout, the … stays at the right, so the header's hamburger shows only when the … isn't drawn at all", async () => {
  const { menuBesideWindowButtons, linuxSidebarCaptionRoom, linuxSidebarHeaderCollapsed, headerFitsDownloads } = await import("./sidebarHeaderLayout.ts");
  const { nativeButtonsChrome } = await import("../../browser/src/lib/platformChrome.desktop.ts");
  const { parseButtonLayout } = await import("../../browser/src/lib/windowButtonLayout.ts");
  const chromes = ["appmenu:close", "menu:close", "close,minimize,maximize:", "close:maximize", ""].map((raw) => [raw, nativeButtonsChrome(parseButtonLayout(raw))]);
  const layouts = [{}, { compactToolbar: true }, { addressBar: "sidebar" }, { sidebarSide: "right" }, { tabLayout: "top" }, { autoHideTabs: true }, { minimalismMode: true }];
  for (const settings of layouts) {
    for (const [raw, chrome] of chromes) {
      const label = JSON.stringify([settings, raw]);
      assert.equal(menuBesideWindowButtons(state(settings), "w", false, chrome), menuBesideWindowButtons(state(settings), "w", false, windowsChrome), label);
      assert.equal(menuBesideWindowButtons(state(settings), "w", true, chrome), false, `${label}: a full-screen page hides the … and the hamburger comes back`);
      assert.equal(menuBesideWindowButtons(state(settings, { fullScreen: true }), "w", false, chrome), false, `${label}: so does full screen`);
    }
    for (const raw of ["close,minimize,maximize:", "close:maximize"]) {
      assert.equal(linuxSidebarHeaderCollapsed(state(settings), "w", false, nativeButtonsChrome(parseButtonLayout(raw))), false, `${JSON.stringify(settings)} ${raw}: the header holds the left buttons`);
    }
  }
  assert.equal(menuBesideWindowButtons(state({ autoHideTabs: true }), "w", false, chromes[2][1]), true, "with the left buttons gone along with the sidebar the … is still at the right");
  const gnome = chromes[0][1];
  const right = state({ sidebarSide: "right" });
  assert.equal(linuxSidebarCaptionRoom(right, "w", false, gnome), gnome.trailingWidth, "the right sidebar keeps room for the … and close");
  assert.ok(gnome.trailingWidth < windowsChrome.trailingWidth);
  assert.equal(headerFitsDownloads(state({ sidebarSide: "right", sidebarWidth: 160 }), "w", false, gnome), true, "two buttons at the right leave Downloads room a narrow header lacks with four");
  assert.equal(headerFitsDownloads(state({ sidebarSide: "right", sidebarWidth: 160 }), "w", false, windowsChrome), false);
});

test("the left group shows wherever it has buttons, hides in full screen, and starts where the Mac's lights start, mirrored in a right sidebar", async () => {
  const { leadingButtonsShown, leadingControlsInset } = await import("./windowControlsRules.ts");
  const { WINDOW_CONTROLS, windowControlsWidth } = await import("../../browser/src/lib/windowChrome.ts");
  const home = { center: [25, 27], trailing: false };
  assert.equal(leadingButtonsShown({ count: 1, pageFullScreen: false, windowFullScreen: false, place: home }), true);
  assert.equal(leadingButtonsShown({ count: 0, pageFullScreen: false, windowFullScreen: false, place: home }), false);
  assert.equal(leadingButtonsShown({ count: 3, pageFullScreen: true, windowFullScreen: false, place: home }), false);
  assert.equal(leadingButtonsShown({ count: 3, pageFullScreen: false, windowFullScreen: true, place: home }), false);
  assert.equal(leadingControlsInset({ center: [25, 27], trailing: false }, 3), WINDOW_CONTROLS.edge, "at the lights' default place the group starts at the Windows build's edge");
  assert.equal(leadingControlsInset({ center: [25 - 190, 27], trailing: false }, 3), WINDOW_CONTROLS.edge - 190, "it slides off with the sidebar, as the lights do");
  const inRightSidebar = leadingControlsInset({ center: [190 - 25, 27], trailing: true }, 2);
  assert.equal(inRightSidebar + windowControlsWidth(2), 190 - WINDOW_CONTROLS.edge, "in a right sidebar it starts 12 px inside the sidebar's left edge");
});

test("the header's tools sit as far past the left group as they sit past the Mac's lights", async () => {
  const { HEADER_TOOLS, headerToggleXFor } = await import("../../browser/src/components/window/dockMotion.ts");
  const { nativeButtonsChrome, TRAFFIC_LIGHTS_CHROME, NATIVE_BUTTONS_CHROME } = await import("../../browser/src/lib/platformChrome.desktop.ts");
  const { parseButtonLayout } = await import("../../browser/src/lib/windowButtonLayout.ts");
  assert.equal(headerToggleXFor(TRAFFIC_LIGHTS_CHROME), 97.75, "the Mac's toggle stays where it was");
  const afterLights = headerToggleXFor(TRAFFIC_LIGHTS_CHROME) - TRAFFIC_LIGHTS_CHROME.leadingWidth;
  for (const raw of ["close:", "close,minimize,maximize:", "close:maximize"]) {
    const chrome = nativeButtonsChrome(parseButtonLayout(raw));
    assert.equal(headerToggleXFor(chrome) - chrome.leadingWidth, afterLights, raw);
  }
  for (const chrome of [NATIVE_BUTTONS_CHROME, nativeButtonsChrome(parseButtonLayout("appmenu:close"))]) assert.equal(headerToggleXFor(chrome), HEADER_TOOLS.fullScreenToggleX, "with nothing at the left the toggle takes the edge slot");
});

test("in a narrow right sidebar the header's toggle never lands on the right group, wherever the left buttons push it", async () => {
  const { linuxSidebarCaptionRoom } = await import("./sidebarHeaderLayout.ts");
  const { sidebarHeaderSplit } = await import("./profileIndicatorLayout.ts");
  const { headerToggleRightEdge: toggleRightEdge, headerToggleXFor, HEADER_TOOLS } = await import("../../browser/src/components/window/dockMotion.ts");
  const { nativeButtonsChrome } = await import("../../browser/src/lib/platformChrome.desktop.ts");
  const { parseButtonLayout, WINDOW_CONTROLS, windowControlsWidth } = await import("../../browser/src/lib/windowButtonLayout.ts");
  const slot = { edge: HEADER_TOOLS.edge, button: 30, pitch: HEADER_TOOLS.pitch };
  for (const raw of ["close,minimize,maximize:", "close:minimize,maximize", ":minimize,maximize,close"]) {
    const chrome = nativeButtonsChrome(parseButtonLayout(raw));
    const controls = WINDOW_CONTROLS.edge + windowControlsWidth(chrome.trailingButtons.length);
    const toggleX = headerToggleXFor(chrome);
    for (const width of [160, 170, 185, 220, 260]) {
      const s = state({ sidebarSide: "right", sidebarWidth: width, addressBar: "sidebar" });
      const captionRoom = linuxSidebarCaptionRoom(s, "w", false, chrome);
      assert.ok(captionRoom > 0, `${raw} ${width}: the right group is drawn in the header`);
      const split = sidebarHeaderSplit({ width, captionRoom, controls, toggleOnly: toggleRightEdge(toggleX), menuInHeader: false, slot });
      const groupLeft = width - controls;
      if (split.tools) assert.ok(toggleRightEdge(toggleX) <= groupLeft, `${raw} ${width}: toggle ends at ${toggleRightEdge(toggleX)}, the right group starts at ${groupLeft}`);
      if (width === 160 && raw !== ":minimize,maximize,close") assert.equal(split.tools, false, `${raw}: 160 px has no room for the toggle beside the buttons`);
    }
    assert.equal(sidebarHeaderSplit({ width: 260, captionRoom: chrome.trailingWidth, controls, toggleOnly: toggleRightEdge(toggleX), menuInHeader: false, slot }).tools, true, `${raw}: a wide sidebar keeps its tools`);
  }
});

test("sliding away with the sidebar the left group is never left as a live sliver where the lights stop being moved", async () => {
  const { leadingButtonsShown, leadingControlsInset } = await import("./windowControlsRules.ts");
  const { stillOffWindow } = await import("../../browser/src/state/windows/dockMotion.ts");
  const { windowControlsWidth } = await import("../../browser/src/lib/windowChrome.ts");
  const slides = [
    { trailing: false, steps: [-79, -80, -81, -100, -165] },
    { trailing: true, steps: [-19, -20, -21, -40, -165] },
  ];
  for (const { trailing, steps } of slides) {
    let sent;
    for (const x of steps) {
      const next = trailing ? [x, 24, "right"] : [x, 24];
      if (!(sent && stillOffWindow(sent, next))) sent = next;
      const place = { center: [sent[0], sent[1]], trailing };
      const shown = leadingButtonsShown({ count: 3, pageFullScreen: false, windowFullScreen: false, place });
      const label = `${trailing ? "right" : "left"} sidebar sliding to ${x}, its place last moved to ${sent[0]}`;
      assert.equal(shown, x === steps[0], label);
    }
  }
  const lastMoved = { center: [-80, 24], trailing: false };
  assert.ok(leadingControlsInset(lastMoved, 3) + windowControlsWidth(3) > 0, "three buttons at the place where the lights stop would still reach onto the window");
  assert.equal(leadingButtonsShown({ count: 3, pageFullScreen: false, windowFullScreen: false, place: lastMoved }), false, "so they aren't drawn there");
});

test("the header's toggle takes the edge slot when the left buttons aren't in its row: above an address bar sidebar, or hidden by a full-screen page", async () => {
  const { sidebarControlsRow, linuxSidebarCaptionRoom, menuBesideWindowButtons } = await import("./sidebarHeaderLayout.ts");
  const { sidebarHeaderSplit, HEADER_MENU } = await import("./profileIndicatorLayout.ts");
  const { headerToggleXIn, headerToggleRightEdge: toggleRightEdge, HEADER_TOOLS, navButtonsFitting } = await import("../../browser/src/components/window/dockMotion.ts");
  const { nativeButtonsChrome, TRAFFIC_LIGHTS_CHROME } = await import("../../browser/src/lib/platformChrome.desktop.ts");
  const { parseButtonLayout, WINDOW_CONTROLS, windowControlsWidth } = await import("../../browser/src/lib/windowButtonLayout.ts");
  const left = nativeButtonsChrome(parseButtonLayout("close,minimize,maximize:"));
  const slot = { edge: HEADER_TOOLS.edge, button: 30, pitch: HEADER_TOOLS.pitch };

  const leads = state({ addressBar: "sidebar", sidebarWidth: 190 });
  const controlsRow = sidebarControlsRow(leads, "w", left) > 0;
  assert.equal(controlsRow, true, "both groups sit in the row above the address bar");
  const toggleX = headerToggleXIn({ windowFullScreen: false, pageFullScreen: false, controlsRow }, left);
  assert.equal(toggleX, HEADER_TOOLS.fullScreenToggleX);
  assert.equal(navButtonsFitting(190 - linuxSidebarCaptionRoom(leads, "w", false, left), 30, true, toggleX).buttons.length, 3, "a 190 px sidebar keeps back, forward and reload");

  for (const sidebarSide of ["left", "right"]) {
    for (const width of [160, 170]) {
      const s = state({ addressBar: "sidebar", sidebarSide, sidebarWidth: width });
      const label = `${sidebarSide} ${width}`;
      assert.equal(menuBesideWindowButtons(s, "w", true, left), false, `${label}: the full-screen page hides the …, so the header holds the hamburger`);
      const pageToggle = headerToggleXIn({ windowFullScreen: false, pageFullScreen: true, controlsRow: sidebarControlsRow(s, "w", left) > 0 }, left);
      assert.equal(pageToggle, HEADER_TOOLS.fullScreenToggleX, label);
      const split = sidebarHeaderSplit({ width, captionRoom: linuxSidebarCaptionRoom(s, "w", true, left), controls: WINDOW_CONTROLS.edge + windowControlsWidth(left.trailingButtons.length), toggleOnly: toggleRightEdge(pageToggle), menuInHeader: true, slot });
      assert.ok(split.menuLeft + HEADER_MENU.width <= width, `${label}: the hamburger ends at ${split.menuLeft + HEADER_MENU.width}`);
      assert.ok(split.menuLeft >= toggleRightEdge(pageToggle), `${label}: and starts after the toggle`);
    }
  }

  const normal = { windowFullScreen: false, pageFullScreen: false, controlsRow: false };
  assert.equal(headerToggleXIn(normal, left), 70.75 + 27 + left.leadingWidth - 78, "with the left buttons in the header row the toggle sits after them");
  assert.equal(headerToggleXIn({ ...normal, windowFullScreen: true }, left), HEADER_TOOLS.fullScreenToggleX);
  for (const chrome of [TRAFFIC_LIGHTS_CHROME, nativeButtonsChrome(parseButtonLayout(":minimize,maximize,close"))]) {
    for (const state of [normal, { ...normal, pageFullScreen: true }, { ...normal, controlsRow: true }]) {
      assert.equal(headerToggleXIn(state, chrome), chrome.leadingWidth ? 97.75 : HEADER_TOOLS.fullScreenToggleX, "chromes without left buttons keep today's toggle");
    }
  }
});

test("the drawn header toggle and Linux's header threshold both read the one toggle rule", async () => {
  const { readFileSync } = await import("node:fs");
  const shared = readFileSync(new URL("../../browser/src/components/sidebar/AddressBar.tsx", import.meta.url), "utf8");
  const linux = readFileSync(new URL("./SidebarAddressBar.tsx", import.meta.url), "utf8");
  assert.match(shared, /const toggleX = useHeaderToggleX\(windowId\);/);
  assert.match(linux, /const toggleOnly = headerToggleRightEdge\(useHeaderToggleX\(windowId\)\);/);
  for (const [name, source] of [["AddressBar.tsx", shared], ["SidebarAddressBar.tsx", linux]]) {
    assert.doesNotMatch(source, /headerToggleXFor|HEADER_TOOLS\.toggleX/, `${name} doesn't bypass useHeaderToggleX`);
  }
});

test("HTMAXBUTTON hover and press events drive the maximize button visual state per window and ignore malformed payloads", async () => {
  const { readFileSync } = await import("node:fs");
  const {
    IDLE_MAXIMIZE_BUTTON_STATE,
    MAXIMIZE_BUTTON_STATE_EVENT,
    followMaximizeButtonState,
    noteMaximizeButtonState,
    parseMaximizeButtonState,
    resetMaximizeButtonState,
    useMaximizeButtonState,
  } = await import("./maximizeButtonState.ts");
  const { mount } = await import("../../browser/src/test-hooks.mjs");

  assert.deepEqual(parseMaximizeButtonState({ windowId: "main", hovered: true, pressed: false }), {
    windowId: "main",
    state: { hovered: true, pressed: false },
  });
  assert.deepEqual(parseMaximizeButtonState({ hovered: true, pressed: true }), {
    windowId: "",
    state: { hovered: true, pressed: true },
  });
  for (const bad of [null, undefined, "hover", 42, {}, { hovered: true }, { pressed: false }, { windowId: 7, hovered: true, pressed: false }, { hovered: "yes", pressed: false }]) {
    assert.equal(parseMaximizeButtonState(bad), null, JSON.stringify(bad));
  }

  const listeners = new Set();
  const host = {
    bootstrap: { windowId: "main", profileId: "default" },
    invoke: async () => null,
    onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
  };
  const emit = (module, event, payload) => listeners.forEach((listener) => listener(module, event, payload));
  const stop = followMaximizeButtonState(host, "main");
  const mounted = mount(() => useMaximizeButtonState("main"));
  try {
    assert.deepEqual(mounted.value, IDLE_MAXIMIZE_BUTTON_STATE);
    emit("ArdiaShell", MAXIMIZE_BUTTON_STATE_EVENT, { windowId: "other", hovered: true, pressed: false });
    assert.deepEqual(mounted.value, IDLE_MAXIMIZE_BUTTON_STATE);
    emit("ArdiaTabs", MAXIMIZE_BUTTON_STATE_EVENT, { windowId: "main", hovered: true, pressed: false });
    assert.deepEqual(mounted.value, IDLE_MAXIMIZE_BUTTON_STATE);
    emit("ArdiaShell", "windowState", { windowId: "main", hovered: true, pressed: true });
    assert.deepEqual(mounted.value, IDLE_MAXIMIZE_BUTTON_STATE);
    emit("ArdiaShell", MAXIMIZE_BUTTON_STATE_EVENT, { windowId: "main", hovered: true, pressed: false });
    assert.deepEqual(mounted.value, { hovered: true, pressed: false });
    emit("ArdiaShell", MAXIMIZE_BUTTON_STATE_EVENT, { windowId: "main", hovered: true, pressed: true });
    assert.deepEqual(mounted.value, { hovered: true, pressed: true });
    emit("ArdiaShell", MAXIMIZE_BUTTON_STATE_EVENT, { windowId: "main", hovered: "bad", pressed: false });
    assert.deepEqual(mounted.value, { hovered: true, pressed: true }, "malformed event never clobbers live state");
    emit("ArdiaShell", MAXIMIZE_BUTTON_STATE_EVENT, { windowId: "main", hovered: false, pressed: false });
    assert.deepEqual(mounted.value, IDLE_MAXIMIZE_BUTTON_STATE);

    noteMaximizeButtonState("main", { hovered: true, pressed: false });
    assert.deepEqual(mounted.value, { hovered: true, pressed: false });
    stop();
    assert.deepEqual(mounted.value, IDLE_MAXIMIZE_BUTTON_STATE, "cleanup resets hover and press state");
    assert.equal(listeners.size, 0);
  } finally {
    mounted.unmount();
    resetMaximizeButtonState("main");
  }

  const wrapper = readFileSync(new URL("./WindowControls.tsx", import.meta.url), "utf8");
  const shared = readFileSync(new URL("../../browser/src/components/window/WindowControls.tsx", import.meta.url), "utf8");
  const entry = readFileSync(new URL("./shellEntry.tsx", import.meta.url), "utf8");
  assert.match(wrapper, /useMaximizeButtonState\(props\.windowId\)/);
  assert.match(wrapper, /maximizeState=\{maximizeState\}/);
  assert.match(shared, /forced=\{button === "maximize" \? maximizeState : undefined\}/);
  assert.match(entry, /followMaximizeButtonState\(ardiaHost, windowId\)/);
});
