import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const nativeSource = (path) => readFileSync(new URL(`../../../engine/ardiacore-linux/src/ardia/linux/${path}`, import.meta.url), "utf8");
const listed = (path, list) => {
  const source = nativeSource(path);
  const from = source.indexOf(`${list}[] = {`);
  assert.ok(from >= 0, `${path} declares ${list}`);
  return [...source.slice(from, source.indexOf("};", from)).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
};
const hostSource = nativeSource("ac_linux_host.cc");
const appended = (name) => {
  assert.ok(hostSource.includes(`capabilities.Append("${name}")`), `the bootstrap advertises ${name}`);
  return name;
};

const ENGINE = {
  system: listed("ac_linux_desktop_core.h", "kSystemCapabilities"),
  openUrls: listed("ac_linux_open_urls.h", "kOpenUrlCapabilities"),
  windowCommands: listed("ac_linux_window_commands.h", "kWindowCommandCapabilities"),
  windowState: listed("ac_linux_window_state.h", "kWindowStateCapabilities"),
  windowCorners: listed("ac_linux_window_corners.h", "kWindowCornersCapabilities"),
  notifications: listed("ac_linux_notifications_core.h", "kNotificationCapabilities"),
  hardware: listed("ac_linux_hardware.h", "kHardwareCapabilities"),
  linkTabs: listed("ac_linux_link_tabs.h", "kLinuxLinkTabRoutes"),
  pageCommits: listed("ac_linux_page_commits.h", "kLinuxPageCommitRoutes"),
  pageKeys: listed("ac_linux_page_keys.h", "kPageKeyCapabilities"),
  appActivation: listed("ac_linux_app_activation.h", "kAppActivationCapabilities"),
  smallWindows: listed("ac_linux_window_lifecycle.h", "kSmallWindowCapabilities"),
  report: listed("ac_linux_report_core.h", "kReportCapabilities"),
  hiddenElements: listed("ac_linux_site_controls.cc", "kBlockerCalls").filter((name) => /^contentBlocker\.(hiddenElements|hideElements|restoreElements)$/.test(name)),
  customFilterLists: listed("ac_linux_site_controls.cc", "kBlockerCalls").filter((name) => /^contentBlocker\.(addList|removeList)$/.test(name)),
  appendedByName: [appended("profiles.deleteData"), appended("ArdiaShell.fetchBangList")],
  wheelZoom: listed("ac_linux_page_messages.h", "kLinuxPageMessageRoutes").filter((route) => route === "webView.setCommandScrollZoom"),
  blockAutoplay: listed("ac_linux_page_messages.h", "kLinuxPageMessageRoutes").filter((route) => route === "webView.setBlockAutoplayEverywhere"),
};
const ALL = Object.values(ENGINE).flat();

const invoked = [];
const hostListeners = new Set();
const host = {
  bootstrap: { windowId: "main", profileId: "default", startup: false, capabilities: ALL },
  invoke: async (method, args) => { invoked.push([method, args]); return null; },
  call: async (name, profile, args) => { invoked.push([name, profile, args]); return "null"; },
  onEvent: (listener) => { hostListeners.add(listener); return () => hostListeners.delete(listener); },
};
const bare = { ...host, bootstrap: { ...host.bootstrap, capabilities: [] } };
globalThis.window = { __ardiaHost: host };
const settings = await import("./settingsIndex.ts");
const shim = await import("./shims/expo-modules-core.ts");
const { linuxCapabilities, unavailableCommands, unavailableSettingIds, FULL_SCREEN_ITEM } = await import("./hostCapabilities.ts");
const { linuxMenuShortcuts } = await import("./shortcuts.ts");
const { staticShortcutSources } = await import("./commandCatalog.ts");
const { sendsFromSheet } = await import("./reportProblem.ts");
delete globalThis.window;
const { appMenuItems } = await import("./appMenu.ts");
const { resolveHostModule, reachesNativeHostUnchecked } = await import("./hostModules.ts");
const { listenForOpenUrls } = await import("./openUrls.ts");
const { relaysSmallWindows } = await import("./hostSmallWindows.ts");
const { servesReportSheet } = await import("./hostReport.ts");
const { deliverPageEvent } = await import("../../../packages/ardiacore/src/pageEvents.ts");
const sharedSettings = await import("../../browser/src/components/settings/settingsIndex.ts");

const find = (items, id) => {
  for (const item of items) {
    if (item.id === id) return item;
    const nested = item.children && find(item.children, id);
    if (nested) return nested;
  }
};
const menuState = { checked: [], disabled: [], titles: {}, profiles: [], windows: [], bookmarkFolders: [], recentBookmarks: [], bookmarksBar: [], otherBookmarks: [], recentlyClosed: [], recentlyClosedGroups: [], warnBeforeQuitting: false, extensions: [] };

test("the engine advertises the names the shell gates on, spelled the same", () => {
  assert.deepEqual(ENGINE.system, ["ArdiaSystem.isDefaultBrowser", "ArdiaSystem.setAsDefaultBrowser", "ArdiaSystem.launchAtLoginStatus", "ArdiaSystem.setLaunchAtLogin", "ArdiaApp.openExternalURL"]);
  assert.deepEqual(ENGINE.openUrls, ["ArdiaShell.onOpenURLs", "ArdiaShell.listenForOpenURLs"]);
  assert.deepEqual(ENGINE.windowCommands, ["ArdiaShell.toggleFullScreen", "tab.edit", "ArdiaShell.readText"]);
  assert.deepEqual(ENGINE.windowState, ["ArdiaShell.windowButtonLayout", "ArdiaShell.windowState"]);
  assert.deepEqual(ENGINE.windowCorners, ["ArdiaShell.windowDecorations"]);
  assert.deepEqual(ENGINE.notifications, ["ArdiaApp.notificationPermission", "ArdiaApp.requestNotificationPermission", "ArdiaApp.postNotification", "ArdiaApp.removeNotifications"]);
  assert.deepEqual(ENGINE.hardware, ["ArdiaApp.hardwareInfo", "ArdiaSystem.setThinScrollBars", "ArdiaShell.setAppearance"]);
  assert.deepEqual(ENGINE.linkTabs, ["webView.setPeekOtherSiteTabs", "webView.setLittleArdiaOpensNewTabLinks"]);
  assert.deepEqual(ENGINE.pageCommits, ["tabs.reportCommits"]);
  assert.deepEqual(ENGINE.pageKeys, ["tab.unhandledEscape"]);
  assert.deepEqual(ENGINE.appActivation, ["ArdiaShell.resignActive"]);
  assert.deepEqual(ENGINE.smallWindows, ["ArdiaShell.smallWindows"]);
  assert.deepEqual(ENGINE.report, ["report.files", "report.send"]);
  assert.deepEqual(ENGINE.hiddenElements, ["contentBlocker.hiddenElements", "contentBlocker.hideElements", "contentBlocker.restoreElements"]);
  assert.deepEqual(ENGINE.customFilterLists, ["contentBlocker.addList", "contentBlocker.removeList"]);
  assert.deepEqual(ENGINE.wheelZoom, ["webView.setCommandScrollZoom"]);
  assert.deepEqual(ENGINE.blockAutoplay, ["webView.setBlockAutoplayEverywhere"]);
});

test("with every new capability on, each Settings row the engine unlocks is shown and searchable", () => {
  const capabilities = linuxCapabilities(host);
  assert.deepEqual(
    { defaultBrowser: capabilities.defaultBrowser, launchAtLogin: capabilities.launchAtLogin, thinScrollBars: capabilities.thinScrollBars, externalLinks: capabilities.externalLinks, commandScrollZoom: capabilities.commandScrollZoom, littleArdiaNewTabLinks: capabilities.littleArdiaNewTabLinks, peekOtherSites: capabilities.peekOtherSites, linksFromOtherApps: capabilities.linksFromOtherApps, fullScreen: capabilities.fullScreen, pageEdits: capabilities.pageEdits },
    { defaultBrowser: true, launchAtLogin: true, thinScrollBars: true, externalLinks: true, commandScrollZoom: true, littleArdiaNewTabLinks: true, peekOtherSites: true, linksFromOtherApps: true, fullScreen: true, pageEdits: true },
  );
  const unlocked = ["general.defaultBrowser", "general.openAtLogin", "tabs.peekLinksToOtherSites", "tabs.openLinksInLittleArdia", "tabs.littleArdiaOpensNewTabLinks", "tabs.appLinksFirst", "automations.meetingAlertCondition"];
  const searchable = new Set(settings.SETTINGS_INDEX.map((item) => item.entry.id));
  const without = unavailableSettingIds(linuxCapabilities(bare), sharedSettings.SETTINGS.map((entry) => entry.id));
  for (const id of unlocked) {
    assert.ok(sharedSettings.SETTINGS.some((entry) => entry.id === id), `${id} is a shared row`);
    assert.equal(settings.settingUnavailable(id), false, id);
    assert.ok(searchable.has(id), `${id} is searchable`);
    if (id !== "automations.meetingAlertCondition") assert.ok(without.has(id), `${id} stays hidden on an engine without it`);
  }
  for (const id of ["tabs.videoUpscaling", "advanced.ardiaCommand", "advanced.compactCliPill"]) assert.equal(settings.settingUnavailable(id), true, `${id} still waits for its own backend`);
  for (const id of ["advanced.pageEngine", "advanced.websiteEngines"]) assert.equal(searchable.has(id), false, id);
});

test("with every new capability on, each command, menu entry and shortcut row appears", () => {
  const capabilities = linuxCapabilities(host);
  const hidden = unavailableCommands(capabilities);
  for (const command of ["emailPageLocation", "toggleOpenLinksInLittleArdia", FULL_SCREEN_ITEM]) assert.equal(hidden.has(command), false, command);
  assert.deepEqual([...hidden].sort(), ["copyLastFreeze", "toggleJavaScriptFromAppleEvents", "togglePageEngine"], "Copy Last Freeze stays hidden: Linux keeps no freeze records");
  for (const command of ["emailPageLocation", "toggleOpenLinksInLittleArdia", FULL_SCREEN_ITEM, "hideElement", "showHiddenElements"]) assert.equal(unavailableCommands(linuxCapabilities(bare)).has(command), true, `${command} is hidden without the engine`);
  const items = appMenuItems(menuState, new Map(), hidden);
  for (const id of ["emailPageLocation", "toggleOpenLinksInLittleArdia", FULL_SCREEN_ITEM, "reportProblem"]) assert.ok(find(items, id), `${id} is in the menu`);
  const bareItems = appMenuItems(menuState, new Map(), unavailableCommands(linuxCapabilities(bare)));
  for (const id of ["emailPageLocation", "toggleOpenLinksInLittleArdia", FULL_SCREEN_ITEM]) assert.equal(find(bareItems, id), undefined, id);
  assert.ok(linuxMenuShortcuts().some((row) => row.id === FULL_SCREEN_ITEM));
  assert.ok(staticShortcutSources().some((source) => source.id === FULL_SCREEN_ITEM));
});

test("with every new capability on, the module calls reach the engine instead of a local answer", async () => {
  invoked.length = 0;
  const calls = [
    ["ArdiaSystem", "isDefaultBrowser", []], ["ArdiaSystem", "setAsDefaultBrowser", []], ["ArdiaSystem", "launchAtLoginStatus", []], ["ArdiaSystem", "setLaunchAtLogin", [true]],
    ["ArdiaSystem", "setThinScrollBars", [true]], ["ArdiaApp", "openExternalURL", ["mailto:a@b.c"]], ["ArdiaApp", "hardwareInfo", []],
    ["ArdiaApp", "notificationPermission", []], ["ArdiaApp", "requestNotificationPermission", []], ["ArdiaApp", "postNotification", [{ id: "n" }]], ["ArdiaApp", "removeNotifications", [["n"]]],
    ["ArdiaShell", "fetchBangList", [null]], ["ArdiaShell", "toggleFullScreen", ["main"]],
    ["ArdiaReport", "draftDirectory", []], ["ArdiaReport", "post", ["https://ardia.dev/api/feedback", "{}", {}]],
  ];
  for (const [module, method, args] of calls) {
    const resolved = resolveHostModule(host, module, method);
    assert.ok(reachesNativeHostUnchecked(resolved) || module === "ArdiaReport", `${module}.${method} is not answered locally`);
    await resolved(...args);
    assert.deepEqual(invoked.at(-1), [`${module}.${method}`, { args }], `${module}.${method}`);
    if (method !== "toggleFullScreen") assert.equal(reachesNativeHostUnchecked(resolveHostModule(bare, module, method)), false, `${module}.${method} is answered locally without the engine`);
  }
  const before = invoked.length;
  for (const [module, call, verb] of [["ArdiaWebView", "webView", "setCommandScrollZoom"], ["ArdiaWebView", "webView", "setPeekOtherSiteTabs"], ["ArdiaWebView", "webView", "setLittleArdiaOpensNewTabLinks"], ["ArdiaProfiles", "profiles", "deleteData"], ["ArdiaTabs", "tabs", "reportCommits"]]) {
    await resolveHostModule(host, module, "call")(verb, "default", "[]");
    assert.deepEqual(invoked.at(-1), [`${call}.${verb}`, "default", "[]"]);
  }
  assert.equal(invoked.length, before + 5);
  assert.equal(listenForOpenUrls(host), true);
  assert.deepEqual(invoked.at(-1), ["ArdiaShell.listenForOpenURLs", { args: [] }]);
  assert.equal(listenForOpenUrls(bare), false);
  assert.equal(relaysSmallWindows(host), true);
  assert.equal(relaysSmallWindows(bare), false);
  assert.equal(servesReportSheet(host), true);
  assert.equal(sendsFromSheet(host), true);
  assert.equal(sendsFromSheet(bare), false);
});

test("the two event-only capabilities need no gate: the engine's events reach the shared listeners", () => {
  const seen = [];
  const subscription = shim.requireNativeModule("ArdiaAppWindows").addListener("onAppEvent", (event) => seen.push(event));
  for (const listener of hostListeners) listener("ArdiaShell", "onAppEvent", { type: "resignActive" });
  subscription.remove();
  assert.deepEqual(seen, [{ type: "resignActive" }]);
  const commands = [];
  deliverPageEvent({ onCommand: (event) => commands.push(event) }, { name: "command", data: { command: "escape", text: "" } });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "escape");
});

test("the window-button layout and window state reach the engine as calls and come back as ArdiaShell events", async () => {
  for (const [method, args] of [["windowButtonLayout", []], ["windowState", ["main"]]]) {
    const resolved = resolveHostModule(host, "ArdiaShell", method);
    assert.ok(reachesNativeHostUnchecked(resolved), `ArdiaShell.${method} is not answered locally`);
    await resolved(...args);
    assert.deepEqual(invoked.at(-1), [`ArdiaShell.${method}`, { args }]);
  }
  const layouts = [];
  const states = [];
  const shell = shim.requireNativeModule("ArdiaShell");
  const layoutSubscription = shell.addListener("windowButtonLayout", (event) => layouts.push(event));
  const stateSubscription = shell.addListener("windowState", (event) => states.push(event));
  const layout = { layout: "appmenu:close", desktop: "ubuntu:GNOME" };
  const state = { windowId: "main", maximized: false, tiled: true, fullScreen: false };
  for (const listener of hostListeners) {
    listener("ArdiaShell", "windowButtonLayout", layout);
    listener("ArdiaShell", "windowState", state);
  }
  layoutSubscription.remove();
  stateSubscription.remove();
  assert.deepEqual(layouts, [layout]);
  assert.deepEqual(states, [state]);
  const nativeHost = nativeSource("ac_linux_host.cc");
  assert.match(nativeHost, /\.Set\("layout", layout && linux_window_state::ReportableToolkitString\(\*layout\) \? base::Value\(\*layout\) : base::Value\(\)\)\s*\.Set\("desktop", CurrentDesktop\(\)\)/);
  for (const key of ["maximized", "tiled", "fullScreen"]) assert.ok(nativeHost.includes(`.Set("${key}", state.`), `windowState carries ${key}`);
  assert.ok(nativeHost.includes('base::Value(WindowStateValue(state).Set("windowId", window_id_))'), "the windowState event names its window");
});

test("an event only the Linux engine sends is declared apart from the Mac's, and the Linux engine does send it", () => {
  const api = readFileSync(new URL("../../../packages/ardiacore/src/engine/api.ts", import.meta.url), "utf8");
  const bodyOf = (name) => api.slice(api.indexOf(`export type ${name} = {`), api.indexOf("\n};", api.indexOf(`export type ${name} = {`)));
  const keysOf = (body) => [...body.matchAll(/^ {2}"([a-zA-Z]+\.[a-zA-Z]+)":/gm)].map((match) => match[1]);
  const linuxOnly = keysOf(bodyOf("LinuxHostEvents"));
  assert.ok(linuxOnly.length > 0);
  const mac = new Set(keysOf(bodyOf("EngineEvents")));
  const engine = new URL("../../../engine/chromium/src/chrome/browser/ardia/", import.meta.url);
  const sent = readdirSync(engine).filter((file) => /_linux\.cc$/.test(file)).map((file) => readFileSync(new URL(file, engine), "utf8")).join("\n");
  for (const name of linuxOnly) {
    assert.equal(mac.has(name), false, `${name} is also in the Mac's events`);
    assert.ok(sent.includes(`Emit("${name}"`), `the Linux engine never sends ${name}`);
  }
});

test("each window counts who decorates it and its desktop's answer once, when the answer settles, and nothing after it stops", async () => {
  const { watchWindowDecorations, WINDOW_DECORATIONS_METHOD, ANSWER_SETTLE_MS, currentWindowCorners } = await import("./windowDecorations.ts");
  const fakeTimers = () => {
    const pending = new Map();
    let next = 0;
    return { set: (run, ms) => { pending.set(++next, { run, ms }); return next; }, clear: (id) => pending.delete(id), fire: () => { for (const [id, { run }] of [...pending]) { pending.delete(id); run(); } }, pending };
  };
  const fakeHost = (reply) => {
    const listeners = new Set();
    const asked = [];
    let answer = () => {};
    const host = {
      bootstrap: { windowId: "main", profileId: "default", capabilities: [WINDOW_DECORATIONS_METHOD] },
      invoke: (method, args) => { asked.push([method, args]); return new Promise((resolve) => { answer = () => resolve(reply); }); },
      call: async () => "null",
      onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const emit = (payload) => { for (const listener of listeners) listener("ArdiaShell", "windowDecorations", payload); };
    return { host, listeners, asked, emit, reply: () => answer() };
  };
  const tick = () => new Promise(setImmediate);

  const timers = fakeTimers();
  const gnome = fakeHost({ decoratedBy: "app", answer: "none", corners: { upperLeft: 9, upperRight: 9, lowerRight: 0, lowerLeft: 0 } });
  const noted = [];
  const stop = watchWindowDecorations(gnome.host, "main", (by, answer) => noted.push([by, answer]), timers);
  await tick();
  gnome.reply();
  await tick();
  assert.deepEqual(gnome.asked, [[WINDOW_DECORATIONS_METHOD, { args: ["main"] }]]);
  assert.deepEqual(noted, [], "nothing counts before the answer settles");
  assert.deepEqual(currentWindowCorners(), { upperLeft: 9, upperRight: 9, lowerRight: 0, lowerLeft: 0 });
  assert.equal([...timers.pending.values()][0].ms, ANSWER_SETTLE_MS);
  gnome.emit({ windowId: "other", decoratedBy: "compositor", answer: "server" });
  gnome.emit({ windowId: "main", decoratedBy: "app", answer: "none", corners: { upperLeft: 0, upperRight: 0, lowerRight: 0, lowerLeft: 0 } });
  assert.deepEqual(currentWindowCorners(), { upperLeft: 0, upperRight: 0, lowerRight: 0, lowerLeft: 0 });
  timers.fire();
  assert.deepEqual(noted, [["app", "none"]]);
  gnome.emit({ windowId: "main", decoratedBy: "compositor", answer: "server" });
  assert.deepEqual(noted, [["app", "none"]], "a window counts once, in one decision bucket");
  stop();
  assert.equal(gnome.listeners.size, 0);

  const hypr = fakeHost({ decoratedBy: "app", answer: "none" });
  const hyprNoted = [];
  watchWindowDecorations(hypr.host, "main", (by, answer) => hyprNoted.push([by, answer]), fakeTimers());
  await tick();
  hypr.emit({ windowId: "main", decoratedBy: "compositor", answer: "none" });
  hypr.emit({ windowId: "main", decoratedBy: "compositor", answer: "server" });
  hypr.reply();
  await tick();
  assert.deepEqual(hyprNoted, [["compositor", "server"]], "the reply that arrives after an event is stale and ignored");

  const quitTimers = fakeTimers();
  const quitting = fakeHost({ decoratedBy: "app", answer: "client" });
  const quitNoted = [];
  const stopEarly = watchWindowDecorations(quitting.host, "main", (by, answer) => quitNoted.push([by, answer]), quitTimers);
  quitting.emit({ windowId: "main", decoratedBy: "app", answer: "none" });
  assert.equal(quitTimers.pending.size, 1);
  stopEarly();
  assert.equal(quitTimers.pending.size, 0, "stopping clears the settle timer");
  await tick();
  quitting.reply();
  await tick();
  quitting.emit({ windowId: "main", decoratedBy: "app", answer: "client" });
  assert.deepEqual(quitNoted, [], "a stopped window counts nothing from a late reply or event");

  const before = fakeHost({ decoratedBy: "app", answer: "client" });
  const beforeNoted = [];
  const stopBefore = watchWindowDecorations(before.host, "main", (by, answer) => beforeNoted.push([by, answer]), fakeTimers());
  await tick();
  stopBefore();
  before.reply();
  await tick();
  assert.deepEqual(beforeNoted, [], "a watcher stopped before any event counts nothing from its reply");

  const bare = fakeHost({});
  bare.host.bootstrap.capabilities = [];
  watchWindowDecorations(bare.host, "main", () => assert.fail("an engine without the call is never asked"));
  assert.deepEqual(bare.asked, []);
});

test("a corner listener that unsubscribes hears no later change of the window's corners", async () => {
  const { watchWindowDecorations, WINDOW_DECORATIONS_METHOD, onWindowCornersChanged } = await import("./windowDecorations.ts");
  const listeners = new Set();
  const host = {
    bootstrap: { windowId: "main", profileId: "default", capabilities: [WINDOW_DECORATIONS_METHOD] },
    invoke: () => new Promise(() => {}),
    call: async () => "null",
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const emit = (radius) => { for (const listener of listeners) listener("ArdiaShell", "windowDecorations", { windowId: "main", decoratedBy: "app", answer: "client", corners: { upperLeft: radius, upperRight: radius, lowerRight: 0, lowerLeft: 0 } }); };
  const stopWatching = watchWindowDecorations(host, "main", () => {});
  let heard = 0;
  const stop = onWindowCornersChanged(() => heard++);
  emit(31);
  emit(32);
  stop();
  emit(33);
  stopWatching();
  assert.equal(heard, 2);
});
