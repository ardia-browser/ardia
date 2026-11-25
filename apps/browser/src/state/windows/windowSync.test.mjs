import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../browser/store.ts");
const { engineProfile, windowTitle } = await import("../browser/model.ts");
const { createWindowSync } = await import("./windowSync.ts");
const { takeLittleArdiaEscapeCloses } = await import("../telemetry/littleArdiaEscapes.ts");

const S = () => useBrowser.getState();
const PROFILES = { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } };
const reset = () => S().hydrate({ profiles: PROFILES, profileOrder: ["default"], windows: {}, tabs: {} });

function fakePort(nativeIds = []) {
  const calls = [];
  let listener = () => {};
  const port = {
    open: (id, options, lightsCenter) => calls.push(["open", id, options, lightsCenter]),
    close: (id) => calls.push(["close", id]),
    setTitle: (id, title) => calls.push(["setTitle", id, title]),
    windowIds: async () => nativeIds,
    restoreFullScreen: (ids, focus) => calls.push(["restoreFullScreen", ids, focus]),
    onEvent: (l) => void (listener = l),
    releaseProfile: (profile) => calls.push(["releaseProfile", profile]),
  };
  return { port, calls, emit: (e) => listener(e), of: (kind) => calls.filter((c) => c[0] === kind) };
}

function start(native, quitting = { on: false }) {
  const sync = createWindowSync({
    port: native.port,
    getState: S,
    isQuitting: () => quitting.on,
    lightsCenter: (s, id) => (s.windows[id]?.kind === "small" ? [1, 1] : [2, 2]),
    isUtilityWindow: (id) => id === "settings",
  });
  sync.listen();
  return sync;
}

test("launch: every window opens once with its lights center, the focused one first, none animated", () => {
  reset();
  const a = S().createWindow();
  const b = S().createWindow();
  const native = fakePort();
  const sync = start(native);
  sync.sync(S());
  const opens = native.of("open");
  assert.deepEqual(opens.map((c) => c[1]), [b, a]);
  assert.equal(opens[0][2].focus, true);
  assert.equal(opens[1][2].behind, b);
  assert.ok(opens.every((c) => !c[2].animated && c[3][0] === 2));
  assert.equal(opens[0][2].title, windowTitle(S(), b));
  sync.sync(S(), S());
  assert.equal(native.of("open").length, 2);
});

test("after launch: a new window opens animated, a closed one closes and its private profile is released", () => {
  reset();
  S().createWindow();
  const native = fakePort();
  const sync = start(native);
  sync.sync(S());
  let prev = S();
  const priv = S().createWindow({ kind: "private" });
  sync.sync(S(), prev);
  const opened = native.of("open").at(-1);
  assert.equal(opened[1], priv);
  assert.equal(opened[2].animated, true);
  assert.equal(opened[2].incognito, true);
  const profile = engineProfile(S(), S().windows[priv].profileId);
  prev = S();
  S().closeWindow(priv);
  sync.sync(S(), prev);
  assert.deepEqual(native.of("close"), [["close", priv]]);
  assert.deepEqual(native.of("releaseProfile"), [["releaseProfile", profile]]);
});

test("a private window's profile is released when sync first hears of the close from an update made inside another subscriber", () => {
  reset();
  S().createWindow();
  const native = fakePort();
  const sync = start(native);
  sync.sync(S());
  let prev = S();
  const priv = S().createWindow({ kind: "private" });
  sync.sync(S(), prev);
  const profile = engineProfile(S(), S().windows[priv].profileId);
  prev = S();
  S().closeWindow(priv);
  const outer = S();
  S().forgetDownloads(prev.windows[priv].profileId);
  sync.sync(S(), outer);
  sync.sync(outer, prev);
  assert.deepEqual(native.of("close"), [["close", priv]]);
  assert.deepEqual(native.of("releaseProfile"), [["releaseProfile", profile]]);
});

test("a private window closed natively releases its profile once, and the store update that follows releases nothing more", () => {
  reset();
  S().createWindow();
  const native = fakePort();
  const sync = start(native);
  sync.sync(S());
  let prev = S();
  const priv = S().createWindow({ kind: "private" });
  sync.sync(S(), prev);
  const profile = engineProfile(S(), S().windows[priv].profileId);
  prev = S();
  native.emit({ type: "close", id: priv });
  sync.sync(S(), prev);
  assert.deepEqual(native.of("releaseProfile"), [["releaseProfile", profile]]);
});

test("a window native closed leaves the store without a second close, unless the app is quitting", () => {
  reset();
  const a = S().createWindow();
  const b = S().createWindow();
  const quitting = { on: false };
  const native = fakePort();
  const sync = start(native, quitting);
  sync.sync(S());
  quitting.on = true;
  native.emit({ type: "close", id: a });
  native.emit({ type: "fullScreen", id: b, on: true });
  assert.ok(S().windows[a]);
  assert.ok(!S().windows[b].fullScreen);
  quitting.on = false;
  const prev = S();
  native.emit({ type: "close", id: a });
  assert.equal(S().windows[a], undefined);
  sync.sync(S(), prev);
  assert.deepEqual(native.of("close"), []);
});

test("titles: only a changed title is sent", () => {
  reset();
  const a = S().createWindow();
  const native = fakePort();
  const sync = start(native);
  sync.sync(S());
  let prev = S();
  S().setWindowFrame(a, [0, 0, 800, 600]);
  sync.sync(S(), prev);
  assert.deepEqual(native.of("setTitle"), []);
  prev = S();
  S().newTab(a);
  sync.sync(S(), prev);
  assert.deepEqual(native.of("setTitle"), [["setTitle", a, windowTitle(S(), a)]]);
});

test("startup sweep: closes native windows the store doesn't have, keeps utility windows, titles the rest", async () => {
  reset();
  const a = S().createWindow();
  const native = fakePort(["orphan", "settings", a]);
  const sync = start(native);
  sync.sync(S());
  await sync.sweep();
  assert.deepEqual(native.of("close"), [["close", "orphan"]]);
  assert.deepEqual(native.of("setTitle"), [["setTitle", a, windowTitle(S(), a)]]);
});

test("a frame the host fitted to a smaller display keeps the saved Little Ardia size; a user's resize saves", () => {
  reset();
  S().updateSettings({ littleArdiaSize: [2406, 1085] });
  const small = S().createWindow({ kind: "small", url: "https://link.example/" });
  const native = fakePort();
  const sync = start(native);
  sync.sync(S());
  native.emit({ type: "frame", id: small, frame: [517, 236, 2406, 1085] });
  assert.deepEqual(S().settings.littleArdiaSize, [2406, 1085]);
  native.emit({ type: "frame", id: small, frame: [-1512, 0, 1512, 950], fitted: true });
  assert.deepEqual(S().windows[small].frame, [-1512, 0, 1512, 950]);
  assert.deepEqual(S().settings.littleArdiaSize, [2406, 1085]);
  native.emit({ type: "frame", id: small, frame: [-1512, 0, 1512, 950] });
  assert.deepEqual(S().settings.littleArdiaSize, [2406, 1085]);
  native.emit({ type: "frame", id: small, frame: [-1400, 20, 1200, 800] });
  assert.deepEqual(S().settings.littleArdiaSize, [1200, 800]);
});

test("a fitted Little Ardia moved to another profile and then dragged keeps the saved size; only a resize saves", () => {
  reset();
  S().updateSettings({ littleArdiaSize: [2406, 1085] });
  const replacement = S().createWindow({ kind: "small", url: "https://link.example/", frame: [-1512, 0, 1512, 950] });
  const native = fakePort();
  const sync = start(native);
  sync.sync(S());
  native.emit({ type: "frame", id: replacement, frame: [-1512, 0, 1512, 950] });
  native.emit({ type: "frame", id: replacement, frame: [-1480, 30, 1512, 950] });
  assert.deepEqual(S().windows[replacement].frame, [-1480, 30, 1512, 950]);
  assert.deepEqual(S().settings.littleArdiaSize, [2406, 1085]);
  native.emit({ type: "frame", id: replacement, frame: [-1480, 30, 1300, 900] });
  assert.deepEqual(S().settings.littleArdiaSize, [1300, 900]);
});

test("each time the host fits a Little Ardia window below the saved size is counted once, a repeat of the fitted size or a fit that keeps the size is not", () => {
  reset();
  S().updateSettings({ littleArdiaSize: [2406, 1085] });
  const small = S().createWindow({ kind: "small", url: "https://link.example/" });
  const native = fakePort();
  const sync = start(native);
  sync.sync(S());
  const fits = () => takeLittleArdiaEscapeCloses().little_ardia_fits_below_saved_size;
  fits();
  native.emit({ type: "frame", id: small, frame: [517, 236, 2406, 1085], fitted: true });
  assert.equal(fits(), 0);
  native.emit({ type: "frame", id: small, frame: [-1512, 0, 1512, 950], fitted: true });
  assert.equal(fits(), 1);
  native.emit({ type: "frame", id: small, frame: [-1500, 10, 1512, 950], fitted: true });
  assert.equal(fits(), 0);
  native.emit({ type: "frame", id: small, frame: [-1400, 20, 1200, 800] });
  assert.equal(fits(), 0);
});

test("full screen comes back oldest first", () => {
  reset();
  const a = S().createWindow();
  const b = S().createWindow();
  const native = fakePort();
  const sync = start(native);
  const s = S();
  sync.restoreFullScreen({ ...s, windows: { ...s.windows, [a]: { ...s.windows[a], fullScreen: 2 }, [b]: { ...s.windows[b], fullScreen: 1 } } });
  assert.deepEqual(native.of("restoreFullScreen"), [["restoreFullScreen", [b, a], (s.ui.focusOrder[0] ?? null)]]);
});

test("a window maximized when the app quit opens maximized at its restored frame, and a closed one comes back the same", () => {
  reset();
  const id = S().createWindow({ url: "https://example.com" });
  const native = fakePort();
  start(native);
  native.emit({ type: "frame", id, frame: [100, 80, 1100, 700] });
  native.emit({ type: "maximized", id, on: true });
  native.emit({ type: "frame", id, frame: [-8, -8, 1936, 1056], restored: [100, 80, 1100, 700] });
  assert.deepEqual(S().windows[id].frame, [-8, -8, 1936, 1056]);
  assert.deepEqual(S().windows[id].restoredFrame, [100, 80, 1100, 700]);
  assert.equal(S().windows[id].maximized, true);

  const relaunch = fakePort();
  start(relaunch).sync(S());
  const [, , options] = relaunch.of("open")[0];
  assert.deepEqual(options.frame, [100, 80, 1100, 700]);
  assert.equal(options.maximized, true);

  S().closeWindow(id, { keepsLastWindow: true });
  assert.deepEqual(S().closedWindows.at(-1).window.restoredFrame, [100, 80, 1100, 700]);
  assert.equal(S().closedWindows.at(-1).window.maximized, true);
  S().restoreClosed(S().closedWindows.at(-1).id);
  const back = S().windowOrder.at(-1);
  assert.deepEqual(S().windows[back].restoredFrame, [100, 80, 1100, 700]);
  assert.equal(S().windows[back].maximized, true);
});

test("restoring a maximized window clears its restored frame and the flag, and quitting keeps them", () => {
  reset();
  const id = S().createWindow();
  const native = fakePort();
  const quitting = { on: false };
  start(native, quitting);
  native.emit({ type: "maximized", id, on: true });
  native.emit({ type: "frame", id, frame: [-8, -8, 1936, 1056], restored: [100, 80, 1100, 700] });
  quitting.on = true;
  native.emit({ type: "maximized", id, on: false });
  assert.equal(S().windows[id].maximized, true);
  quitting.on = false;
  native.emit({ type: "maximized", id, on: false });
  native.emit({ type: "frame", id, frame: [100, 80, 1100, 700] });
  assert.equal(S().windows[id].maximized, undefined);
  assert.equal(S().windows[id].restoredFrame, undefined);
  assert.deepEqual(S().windows[id].frame, [100, 80, 1100, 700]);
});
