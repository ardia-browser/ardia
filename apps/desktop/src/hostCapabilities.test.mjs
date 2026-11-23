import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PAGE_OPTION_CALLS, resolveHostModule } from "./hostModules.ts";
import { CLI_CONTROL_METHODS, CLI_INSTALL_METHODS, DICTATION_METHOD, LINKS_FROM_OTHER_APPS, SELF_UPDATE_METHODS, USER_SCRIPTS_METHODS, linuxCapabilities, unavailableSettingIds } from "./hostCapabilities.ts";
import { CAST_UNAVAILABLE_TITLE, linuxMediaCall } from "./hostCast.ts";
import { USER_SCRIPTS_LOCK, leadUserScripts } from "./hostUserScripts.ts";
import { useBrowser } from "../../browser/src/state/browser/store.ts";
import { useToasts } from "../../browser/src/state/app/toasts.ts";

function fakeHost(capabilities = []) {
  const invoked = [];
  return {
    invoked,
    host: {
      bootstrap: { windowId: "w1", profileId: "default", capabilities },
      invoke: async (method, args) => { invoked.push(method); throw new Error(`Unknown host method ${method}`); },
      call: async () => "{}",
      onEvent: () => () => {},
    },
  };
}

test("absent default-browser, login and scrollbar backends answer truthfully without reaching the host", async () => {
  const { host, invoked } = fakeHost();
  const system = (method) => resolveHostModule(host, "ArdiaSystem", method);
  await assert.rejects(system("isDefaultBrowser")(), { code: "ERR_UNAVAILABLE" });
  await assert.rejects(system("setAsDefaultBrowser")(), { code: "ERR_UNAVAILABLE" });
  assert.equal(await system("launchAtLoginStatus")(), "notFound");
  await assert.rejects(system("setLaunchAtLogin")(true), { code: "ERR_UNAVAILABLE" });
  assert.equal(await system("setThinScrollBars")(true), undefined);
  assert.deepEqual(invoked, []);
});

test("a host that advertises a system backend is called through instead of being masked", async () => {
  const { host, invoked } = fakeHost(["ArdiaSystem.isDefaultBrowser", "ArdiaSystem.setAsDefaultBrowser", "ArdiaSystem.setThinScrollBars"]);
  await assert.rejects(resolveHostModule(host, "ArdiaSystem", "isDefaultBrowser")(), /Unknown host method/);
  await assert.rejects(resolveHostModule(host, "ArdiaSystem", "setThinScrollBars")(true), /Unknown host method/);
  assert.deepEqual(invoked, ["ArdiaSystem.isDefaultBrowser", "ArdiaSystem.setThinScrollBars"]);
});

test("Linux capabilities come from the host contract, and WebKit is never offered", () => {
  assert.deepEqual(linuxCapabilities(fakeHost().host), {
    defaultBrowser: false, launchAtLogin: false, thinScrollBars: false, webkit: false, cliControl: false, cliInstall: false, userScripts: false, externalLinks: false, performanceRecording: false, taskManager: false, busyTabWatch: false, videoUpscaling: false,
    commandScrollZoom: false, littleArdiaNewTabLinks: false, peekOtherSites: false, popupsOpenAsTabs: false, haptics: false, linksFromOtherApps: false, dictation: false, fullScreen: false, pageEdits: false,
    unloadIdleProfiles: false, hiddenElements: false, blockAutoplayEverywhere: false, selfUpdate: false,
  });
  const full = linuxCapabilities(fakeHost(["ArdiaSystem.isDefaultBrowser", "ArdiaSystem.setAsDefaultBrowser", "ArdiaSystem.launchAtLoginStatus", "ArdiaSystem.setLaunchAtLogin", "ArdiaSystem.setThinScrollBars", "engine.beginTracing", "engine.endTracing", "engine.isTracing", "engine.openTaskManager", "ArdiaApp.openExternalURL"]).host);
  assert.deepEqual(full, { defaultBrowser: true, launchAtLogin: true, thinScrollBars: true, webkit: false, cliControl: false, cliInstall: false, userScripts: false, externalLinks: true, performanceRecording: true, taskManager: true, busyTabWatch: false, videoUpscaling: false, commandScrollZoom: false, littleArdiaNewTabLinks: false, peekOtherSites: false, popupsOpenAsTabs: false, haptics: false, linksFromOtherApps: false, dictation: false, fullScreen: false, pageEdits: false, unloadIdleProfiles: false, hiddenElements: false, blockAutoplayEverywhere: false, selfUpdate: false });
  const routed = linuxCapabilities(fakeHost(["webView.setCommandScrollZoom", "webView.setLittleArdiaOpensNewTabLinks", "webView.setPeekOtherSiteTabs", "ArdiaSystem.hapticTick", LINKS_FROM_OTHER_APPS, DICTATION_METHOD]).host);
  assert.deepEqual([routed.commandScrollZoom, routed.littleArdiaNewTabLinks, routed.peekOtherSites, routed.haptics, routed.linksFromOtherApps, routed.dictation], [true, true, true, true, true, true]);
  assert.equal(linuxCapabilities(undefined).taskManager, false);
  assert.equal(linuxCapabilities(fakeHost([...SELF_UPDATE_METHODS]).host).selfUpdate, true);
  assert.equal(linuxCapabilities(fakeHost(SELF_UPDATE_METHODS.slice(1)).host).selfUpdate, false);
});

test("the command bar's Dictate button follows the dictation capability: off while the host has no dictation, without reaching the host", () => {
  const { host, invoked } = fakeHost();
  assert.equal(resolveHostModule(host, "ArdiaShell", "dictationAvailable")(), false);
  assert.equal(linuxCapabilities(host).dictation, false);
  assert.equal(linuxCapabilities(fakeHost([DICTATION_METHOD]).host).dictation, true);
  assert.deepEqual(invoked, []);
});

test("unavailable choices map to exact settings ids and the Web engine rows", () => {
  const ids = ["general.defaultBrowser", "general.openAtLogin", "general.askBefore", "advanced.pageEngine", "advanced.websiteEngines", "profiles.otherEngines", "advanced.ardiaCommand", "advanced.compactCliPill", "advanced.showFullUrl", "tabs.videoUpscaling", "tabs.autoPictureInPicture"];
  const unrouted = ["tabs.openLinksInLittleArdia", "tabs.appLinksFirst", "tabs.littleArdiaOpensNewTabLinks", "tabs.peekLinksToOtherSites", "tabs.popupsOpenAsTabs"];
  const routedRows = { littleArdiaNewTabLinks: true, peekOtherSites: true, popupsOpenAsTabs: true, linksFromOtherApps: true };
  const webEngine = ["advanced.pageEngine", "advanced.websiteEngines"];
  const none = linuxCapabilities(fakeHost().host);
  assert.deepEqual([...unavailableSettingIds(none, ids)].sort(), [...unrouted, ...webEngine, "advanced.ardiaCommand", "advanced.compactCliPill", "general.autoUpdate", "general.defaultBrowser", "general.openAtLogin", "tabs.videoUpscaling"].sort());
  for (const [capability, rows] of Object.entries({ littleArdiaNewTabLinks: ["tabs.littleArdiaOpensNewTabLinks"], peekOtherSites: ["tabs.peekLinksToOtherSites"], popupsOpenAsTabs: ["tabs.popupsOpenAsTabs"], linksFromOtherApps: ["tabs.openLinksInLittleArdia", "tabs.appLinksFirst"] })) {
    const shown = unavailableSettingIds({ ...none, [capability]: true }, ids);
    assert.deepEqual(unrouted.filter((id) => !shown.has(id)), rows, capability);
  }
  assert.deepEqual([...unavailableSettingIds({ ...none, webkit: true }, ids)].filter((id) => webEngine.includes(id)), []);
  assert.deepEqual([...unavailableSettingIds(none, ["general.defaultBrowser"])].filter((id) => webEngine.includes(id)), []);
  assert.deepEqual([...unavailableSettingIds({ ...none, defaultBrowser: true, launchAtLogin: true, cliControl: true, cliInstall: true, videoUpscaling: true, ...routedRows }, ids)].sort(), [...webEngine, "general.autoUpdate"]);
  assert.equal(unavailableSettingIds({ ...none, selfUpdate: true }, ids).has("general.autoUpdate"), false, "an engine that installs updates lets Settings decide from the install kind");
  const cliRows = (capabilities) => [...unavailableSettingIds(capabilities, ids)].filter((id) => id === "advanced.ardiaCommand" || id === "advanced.compactCliPill").sort();
  assert.deepEqual(cliRows({ ...none, cliControl: true }), []);
  assert.deepEqual(cliRows({ ...none, cliInstall: true }), ["advanced.ardiaCommand", "advanced.compactCliPill"]);
});

test("the ardia command's rows follow the engine: every control and install method, or the rows stay hidden", () => {
  assert.equal(linuxCapabilities(fakeHost([...CLI_CONTROL_METHODS]).host).cliControl, true);
  assert.equal(linuxCapabilities(fakeHost([...CLI_INSTALL_METHODS]).host).cliInstall, true);
  for (const missing of CLI_CONTROL_METHODS) {
    assert.equal(linuxCapabilities(fakeHost(CLI_CONTROL_METHODS.filter((method) => method !== missing)).host).cliControl, false, missing);
  }
  assert.equal(linuxCapabilities(fakeHost(["ArdiaCli.install"]).host).cliInstall, false);
});

function cliHost(capabilities, installedVersion) {
  const invoked = [];
  const listeners = [];
  const answers = { "ArdiaCli.installedVersion": "0.2.44", "ArdiaCli.install": { ok: true, appVersion: "0.2.45", binPath: "/home/u/.local/bin/ardia", installedVersion: "0.2.45", lines: [] } };
  return {
    invoked,
    emit: (module, event, payload) => listeners.forEach((listener) => listener(module, event, payload)),
    host: {
      bootstrap: { windowId: "w1", profileId: "default", capabilities, nativeModules: installedVersion === undefined ? {} : { ArdiaCli: { installedVersion } } },
      invoke: async (method, args) => {
        invoked.push([method, args.args]);
        if (method in answers) return answers[method];
        return undefined;
      },
      call: async () => "{}",
      onEvent: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    },
  };
}

test("the installed ardia version answers synchronously from the bootstrap, then from the host's refresh, installs and announcements", async () => {
  const { host, invoked, emit } = cliHost([...CLI_INSTALL_METHODS], "0.2.43");
  const installedVersion = resolveHostModule(host, "ArdiaCli", "installedVersion");
  assert.equal(installedVersion(), "0.2.43");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(invoked, [["ArdiaCli.installedVersion", []]]);
  assert.equal(resolveHostModule(host, "ArdiaCli", "installedVersion")(), "0.2.44");
  const result = await resolveHostModule(host, "ArdiaCli", "install")();
  assert.equal(result.ok, true);
  assert.equal(resolveHostModule(host, "ArdiaCli", "installedVersion")(), "0.2.45");
  emit("ArdiaCli", "onInstalledVersion", { version: null });
  assert.equal(resolveHostModule(host, "ArdiaCli", "installedVersion")(), null);
  emit("ArdiaShell", "onInstalledVersion", { version: "9.9.9" });
  assert.equal(resolveHostModule(host, "ArdiaCli", "installedVersion")(), null);
  assert.equal(invoked.filter(([method]) => method === "ArdiaCli.installedVersion").length, 1);
});

test("an engine without the ardia command keeps the old answers and never reaches the host", async () => {
  const { host, invoked } = cliHost([]);
  assert.equal(resolveHostModule(host, "ArdiaCli", "installedVersion")(), null);
  assert.equal((await resolveHostModule(host, "ArdiaCli", "install")().catch((error) => error)).code, "ERR_UNAVAILABLE");
  assert.deepEqual(await resolveHostModule(host, "ArdiaAutomation", "start")(), { state: "off", generation: 0, path: "", reason: "the control socket is unavailable on Linux" });
  assert.equal(resolveHostModule(host, "ArdiaAutomation", "reply")(1, "{}", 0), undefined);
  assert.deepEqual(invoked, []);
});

test("the control socket's methods reach the host once it advertises them, and reply and broadcast stay fire and forget", async () => {
  const { host, invoked } = cliHost([...CLI_CONTROL_METHODS]);
  await resolveHostModule(host, "ArdiaAutomation", "start")();
  assert.equal(resolveHostModule(host, "ArdiaAutomation", "reply")(3, "{\"id\":1}", 7), undefined);
  assert.equal(resolveHostModule(host, "ArdiaAutomation", "broadcast")([3, 4], "{\"event\":\"tab.opened\"}"), undefined);
  await resolveHostModule(host, "ArdiaAutomation", "stop")();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(invoked, [
    ["ArdiaAutomation.start", []],
    ["ArdiaAutomation.reply", [3, "{\"id\":1}", 7]],
    ["ArdiaAutomation.broadcast", [[3, 4], "{\"event\":\"tab.opened\"}"]],
    ["ArdiaAutomation.stop", []],
  ]);
});

test("userscripts run only on an engine that advertises all four ArdiaUserScripts methods", () => {
  assert.equal(linuxCapabilities(fakeHost([...USER_SCRIPTS_METHODS]).host).userScripts, true);
  for (const missing of USER_SCRIPTS_METHODS) {
    assert.equal(linuxCapabilities(fakeHost(USER_SCRIPTS_METHODS.filter((method) => method !== missing)).host).userScripts, false, missing);
  }
});

test("the userscripts folder's methods reach the host, and watch stays fire and forget", async () => {
  const { host, invoked } = cliHost([...USER_SCRIPTS_METHODS]);
  host.invoke = async (method, args) => {
    invoked.push([method, args.args]);
    if (method === "ArdiaUserScripts.watch") throw new Error("not a regular window");
    return method === "ArdiaUserScripts.read" ? { state: "ready", generation: 2, path: "/d/Scripts/extension", token: "t" } : null;
  };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.equal(resolveHostModule(host, "ArdiaUserScripts", "watch")(true), undefined);
    assert.deepEqual(await resolveHostModule(host, "ArdiaUserScripts", "read")(), { state: "ready", generation: 2, path: "/d/Scripts/extension", token: "t" });
    assert.equal(await resolveHostModule(host, "ArdiaUserScripts", "readStatus")(), null);
    await resolveHostModule(host, "ArdiaUserScripts", "writeStatus")("{\"generation\":2}");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.deepEqual(invoked, [
    ["ArdiaUserScripts.watch", [true]],
    ["ArdiaUserScripts.read", []],
    ["ArdiaUserScripts.readStatus", []],
    ["ArdiaUserScripts.writeStatus", ["{\"generation\":2}"]],
  ]);
});

test("one window at a time applies userscripts: the holder keeps the lock, and the next window takes over when the holder's window closes", async () => {
  const waiting = [];
  let holder = null;
  const grant = () => {
    if (holder || !waiting.length) return;
    holder = waiting.shift();
    let released = false;
    holder.callback().then(() => { released = true; holder.resolve(); });
    holder.released = () => released;
  };
  const locks = {
    request(name, callback) {
      assert.equal(name, USER_SCRIPTS_LOCK);
      return new Promise((resolve) => { waiting.push({ callback, resolve }); grant(); });
    },
  };
  const closeHoldingWindow = () => { holder = null; grant(); };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const started = [];
  leadUserScripts({ locks, start: () => started.push("w1") });
  leadUserScripts({ locks, start: () => started.push("w2") });
  await tick();
  assert.deepEqual(started, ["w1"]);
  assert.equal(holder.released(), false, "the applying window never gives the lock back on its own");
  assert.equal(waiting.length, 1);
  closeHoldingWindow();
  await tick();
  assert.deepEqual(started, ["w1", "w2"]);
  assert.equal(waiting.length, 0);
});

test("without web locks, or when the lock fails, the window applies userscripts itself", async () => {
  const started = [];
  leadUserScripts({ start: () => started.push("plain") });
  const reported = [];
  leadUserScripts({ locks: { request: () => Promise.reject(new Error("no locks")) }, start: () => started.push("failed"), report: (error) => reported.push(error.message) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ["plain", "failed"]);
  assert.deepEqual(reported, ["no locks"]);
});

test("a failed fire-and-forget reply is reported, never thrown at the caller", async () => {
  const { host } = cliHost([...CLI_CONTROL_METHODS]);
  host.invoke = async () => { throw new Error("gone"); };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.equal(resolveHostModule(host, "ArdiaAutomation", "reply")(1, "{}", 0), undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
});

test("onboarding music and external links answer locally when the host has no backend for them", async () => {
  const { host, invoked } = fakeHost();
  const app = (method) => resolveHostModule(host, "ArdiaApp", method);
  assert.equal(await app("playIntroMusic")({}, false), undefined);
  assert.equal(await app("setIntroMusicMuted")(true), undefined);
  assert.equal(await app("stopIntroMusic")(0.6), undefined);
  assert.equal(await app("openExternalURL")("mailto:someone@example.com"), false);
  assert.deepEqual(invoked, []);
  const advertised = fakeHost(["ArdiaApp.openExternalURL"]);
  await assert.rejects(resolveHostModule(advertised.host, "ArdiaApp", "openExternalURL")("mailto:x"), /Unknown host method/);
  assert.deepEqual(advertised.invoked, ["ArdiaApp.openExternalURL"]);
});

const nativeSource = (path) => readFileSync(new URL(`../../../engine/ardiacore-linux/src/ardia/linux/${path}`, import.meta.url), "utf8");
const listedRoutes = (path, list, route = /"([^"]+)"/g) => {
  const source = nativeSource(path);
  const start = source.indexOf(`${list}[]`);
  return [...source.slice(start, source.indexOf(";", start)).matchAll(route)].map((match) => match[1]);
};

test("the native bootstrap advertises every route list, and every shared performance engine call is advertised or gated", () => {
  const host = nativeSource("ac_linux_host.cc");
  const bootstrap = host.slice(host.indexOf("base::DictValue ShellHostView::Bootstrap() const {"), host.indexOf("void ShellHostView::LayoutOverlay()"));
  for (const list of ["linux_contract::kRoutes", "kLinuxZoomDomainRoutes", "kLinuxMemorySaverRoutes"]) assert.ok(bootstrap.includes(`: ardiacore::${list})`), list);
  const advertised = new Set([
    ...listedRoutes("ac_linux_contract.h", "kRoutes", /\{"([^"]+)",/g),
    ...listedRoutes("ac_linux_history_zoom.h", "kLinuxZoomDomainRoutes"),
    ...listedRoutes("ac_linux_memory_saver.h", "kLinuxMemorySaverRoutes"),
    ...[...host.matchAll(/capabilities\.Append\("(engine\.\w+)"\)/g)].map((match) => match[1]),
  ]);
  assert.equal(linuxCapabilities(fakeHost([...advertised]).host).taskManager, true);
  const uses = [...readFileSync(new URL("../../browser/src/platform/performance.ts", import.meta.url), "utf8").matchAll(/^export const \w+ = [^\n]*?\b(call|on)\("(engine\.\w+)"/gm)].map((match) => ({ kind: match[1], name: match[2] }));
  const used = uses.map((use) => use.name);
  for (const call of ["engine.memorySaver", "engine.validateKeepActiveSite", "engine.tasks"]) assert.ok(used.includes(call), call);
  const gated = { "engine.beginTracing": "performanceRecording", "engine.endTracing": "performanceRecording", "engine.isTracing": "performanceRecording", "engine.childProcessCpu": "busyTabWatch" };
  const macOnlyEvents = new Set(["engine.hoverLost", "engine.cursorRestored", "engine.pressLoopLong", "engine.windowUnpainted", "engine.popupProtectedMedia", "engine.devToolsKeyKept"]);
  for (const name of macOnlyEvents) assert.deepEqual(uses.filter((use) => use.name === name).map((use) => use.kind), ["on"], `${name} is only listened to`);
  const none = linuxCapabilities(fakeHost().host);
  for (const call of used) {
    if (advertised.has(call) || macOnlyEvents.has(call)) continue;
    assert.ok(gated[call], `${call} is neither advertised by the Linux host nor gated`);
    assert.equal(none[gated[call]], false);
  }
});

test("Memory Saver settings and kept-active site checks reach the host as engine calls for the window's profile", async () => {
  const calls = [];
  const replies = { "engine.memorySaver": { state: "off", aggressiveness: "maximum", active: false, sites: ["youtube.com"], invalid: [] }, "engine.validateKeepActiveSite": { valid: true } };
  const host = {
    bootstrap: { windowId: "w1", profileId: "work", capabilities: ["engine.memorySaver", "engine.validateKeepActiveSite"] },
    invoke: async (method) => { throw new Error(`Unknown host method ${method}`); },
    call: async (name, profile, args) => { calls.push([name, profile, JSON.parse(args)]); return JSON.stringify(replies[name]); },
    onEvent: () => () => {},
  };
  const engineCall = resolveHostModule(host, "ArdiaEngine", "call");
  const request = { state: "off", aggressiveness: "maximum", sites: ["youtube.com"] };
  assert.deepEqual(JSON.parse(await engineCall("memorySaver", "", JSON.stringify(request))), replies["engine.memorySaver"]);
  assert.deepEqual(JSON.parse(await engineCall("validateKeepActiveSite", "", JSON.stringify({ site: "youtube.com" }))), { valid: true });
  assert.deepEqual(calls, [["engine.memorySaver", "work", request], ["engine.validateKeepActiveSite", "work", { site: "youtube.com" }]]);
});

test("accepting a site's notification prompt on Linux settles quietly when the desktop has no notification permission to ask", async () => {
  const { shellNativeModules } = await import("../../browser/src/test-native/index.ts");
  const { ensureNotificationPermission } = await import("./notificationPermission.ts");
  const app = shellNativeModules.ArdiaNotifications;
  const original = app.notificationPermission;
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  app.notificationPermission = () => Promise.reject(Object.assign(new Error("Desktop notifications is unavailable on Linux"), { code: "ERR_UNAVAILABLE" }));
  try {
    assert.equal(await ensureNotificationPermission("main"), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    app.notificationPermission = original;
    process.off("unhandledRejection", record);
  }
});

test("a notification permission failure other than Linux's unavailable answer still rejects", async () => {
  const { shellNativeModules } = await import("../../browser/src/test-native/index.ts");
  const { ensureNotificationPermission } = await import("./notificationPermission.ts");
  const app = shellNativeModules.ArdiaNotifications;
  const original = app.notificationPermission;
  const failure = Object.assign(new Error("The host went away"), { code: "ERR_HOST_GONE" });
  app.notificationPermission = () => Promise.reject(failure);
  try {
    await assert.rejects(ensureNotificationPermission("main"), (error) => error === failure);
  } finally {
    app.notificationPermission = original;
  }
});

test("casting answers with an explicit unavailable state instead of a silent rejection", async () => {
  useBrowser.getState().hydrate({});
  const windowId = useBrowser.getState().createWindow({ url: "https://cast.ardia.test/" });
  const tabId = useBrowser.getState().windows[windowId].tabIds[0];
  useToasts.setState({ toasts: {} });
  assert.equal(await linuxMediaCall("showCastDialog", JSON.stringify({ tabId })), "false");
  assert.equal(useToasts.getState().toasts[windowId]?.title, CAST_UNAVAILABLE_TITLE);
  assert.equal(await linuxMediaCall("watchCastRoutes", JSON.stringify({ profile: "" })), "null");
  for (const verb of ["startCasting", "stopCasting", "closeCastDialog", "terminateCastRoute", "changeCaptureSource", "stopCapture"]) {
    await assert.rejects(linuxMediaCall(verb, "{}", () => false), (error) => error.code === "ERR_UNAVAILABLE", verb);
  }
});

test("switching the shared tab and stopping a capture reach a host that advertises them, and casting never does", async () => {
  const advertised = (method) => method === "media.changeCaptureSource" || method === "media.stopCapture" || method === "media.startCasting";
  assert.equal(linuxMediaCall("changeCaptureSource", JSON.stringify({ capturer: "a", target: "b" }), advertised), undefined);
  assert.equal(linuxMediaCall("stopCapture", JSON.stringify({ tabId: "a" }), advertised), undefined);
  await assert.rejects(linuxMediaCall("startCasting", "{}", advertised), (error) => error.code === "ERR_UNAVAILABLE");
  const onlyStop = (method) => method === "media.stopCapture";
  await assert.rejects(linuxMediaCall("changeCaptureSource", "{}", onlyStop), (error) => error.code === "ERR_UNAVAILABLE");
});

test("the media domain keeps reaching the host for everything but casting", async () => {
  const calls = [];
  const host = { bootstrap: { capabilities: [], nativeModules: {} }, call: async (name) => { calls.push(name); return "null"; }, invoke: async () => null, onEvent: () => {} };
  const call = resolveHostModule(host, "ArdiaMedia", "call");
  assert.equal(await call("selectDevice", "", JSON.stringify({ id: 1, index: 0 })), "null");
  assert.equal(await call("showCastDialog", "", JSON.stringify({ tabId: "missing" })), "false");
  assert.deepEqual(calls, ["media.selectDevice"]);
});

test("casting reaches an engine that advertises every cast call, and a partial set still shows the notice", async () => {
  const verbs = ["showCastDialog", "startCasting", "stopCasting", "closeCastDialog", "watchCastRoutes", "terminateCastRoute"];
  const everything = (method) => verbs.some((verb) => method === `media.${verb}`);
  useToasts.setState({ toasts: {} });
  for (const verb of verbs) assert.equal(linuxMediaCall(verb, JSON.stringify({ tabId: "t" }), everything), undefined, verb);
  assert.deepEqual(useToasts.getState().toasts, {});
  const missingRoutes = (method) => everything(method) && method !== "media.watchCastRoutes";
  assert.equal(await linuxMediaCall("watchCastRoutes", "{}", missingRoutes), "null");
  await assert.rejects(linuxMediaCall("startCasting", "{}", missingRoutes), (error) => error.code === "ERR_UNAVAILABLE");
  const calls = [];
  const host = { bootstrap: { capabilities: verbs.map((verb) => `media.${verb}`), nativeModules: {} }, call: async (name) => { calls.push(name); return "true"; }, invoke: async () => null, onEvent: () => {} };
  const call = resolveHostModule(host, "ArdiaMedia", "call");
  assert.equal(await call("showCastDialog", "", JSON.stringify({ tabId: "t" })), "true");
  assert.equal(await call("watchCastRoutes", "", JSON.stringify({ profile: "" })), "true");
  assert.deepEqual(calls, ["media.showCastDialog", "media.watchCastRoutes"]);
});

test("a page option the host has no backend for is settled here, and reaches a host that advertises it", async () => {
  const calls = [];
  const host = (capabilities) => ({ bootstrap: { profileId: "default", capabilities, nativeModules: {} }, call: async (name, profile, args) => { calls.push([name, args]); return "null"; }, invoke: async () => null, onEvent: () => {} });
  const without = resolveHostModule(host([]), "ArdiaWebView", "call");
  for (const name of PAGE_OPTION_CALLS) assert.equal(await without(name.slice("webView.".length), "", JSON.stringify({ enabled: true })), "null", name);
  assert.deepEqual(calls, []);
  assert.equal(await without("setPeekModifier", "", JSON.stringify({ modifier: "alt" })), "null");
  assert.deepEqual(calls, [["webView.setPeekModifier", JSON.stringify({ modifier: "alt" })]]);
  calls.length = 0;
  const withZoom = resolveHostModule(host(["webView.setCommandScrollZoom"]), "ArdiaWebView", "call");
  await withZoom("setCommandScrollZoom", "", JSON.stringify({ enabled: false }));
  await withZoom("setVideoUpscaling", "", JSON.stringify({ enabled: true }));
  assert.deepEqual(calls, [["webView.setCommandScrollZoom", JSON.stringify({ enabled: false })]]);
});

test("an engine without full screen or page editing offers neither, and F11 stays Chromium's", async () => {
  const { linuxBindings, linuxMenuShortcuts } = await import("./shortcuts.ts");
  const { unavailableCommands } = await import("./hostCapabilities.ts");
  const { host } = fakeHost();
  const capabilities = linuxCapabilities(host);
  assert.equal(capabilities.fullScreen, false);
  assert.equal(capabilities.pageEdits, false);
  assert.equal(unavailableCommands(capabilities).has("std:toggleFullScreen:"), true);
  assert.equal(linuxMenuShortcuts().some((item) => item.id === "std:toggleFullScreen:"), false);
  assert.equal(linuxBindings().some((binding) => binding.command === "toggleFullScreen" || binding.keyCode === 122), false);
  const advertised = linuxCapabilities(fakeHost(["ArdiaShell.toggleFullScreen", "tab.edit"]).host);
  assert.deepEqual([advertised.fullScreen, advertised.pageEdits], [true, true]);
});
