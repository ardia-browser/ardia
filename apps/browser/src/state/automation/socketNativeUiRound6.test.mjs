import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const surfacesModule = await import("./socketSurfaces.ts");
const { runMethod } = await import("./controlSocket.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-round6-test");

const { call, ok } = socketClient(37);

const item = (path, title, more) => ({ path, title, enabled: true, checked: false, separator: false, ...more });
const STRUCTURE = new Set(["path", "title", "separator", "ref", "key", "command", "arg", "action", "boundWindow", "submenu"]);
const flat = (items) => items.flatMap((i) => [i, ...flat(i.submenu ?? [])]);

function barWith(state) {
  return [
    item([2], "View", {
      submenu: [
        item([2, 0], "Back", { command: "back", ref: "cmd:back@View\u001fBack", enabled: state.canGoBack, hidden: !state.canGoBack }),
        item([2, 1], "Reload", { command: "reload", ref: "cmd:reload@View\u001fReload", checked: state.loading, mixed: state.loading }),
        item([2, 2], "Mute Tab", { command: "toggleMute", ref: "cmd:toggleMute@View\u001fMute Tab", checked: state.muted, alternate: state.muted }),
      ],
    }),
  ];
}

test("a private window opened while the catalog is read stops the command before run", async () => {
  const { windowId } = await freshWindow();
  const newTab = item([1, 0], "New Tab", { command: "newTab", ref: "cmd:newTab@File\u001fNew Tab" });
  stub.surfaces.bar = [item([1], "File", { ref: "menu@File", submenu: [newTab] })];
  const tabsBefore = Object.keys(S().tabs).length;
  stub.surfaces.barHook = () => S().createWindow({ kind: "private", url: "https://p.example/" });
  const reply = await call("menus.runBar", { path: newTab.path, ref: newTab.ref, window: windowId });
  stub.surfaces.barHook = null;
  assert.equal(reply.error?.code, "refused");
  assert.match(reply.error.message, /private window is open/);
  await tick();
  const regularTabs = Object.values(S().tabs).filter((t) => S().windows[t.windowId]?.kind !== "private").length;
  assert.equal(regularTabs, tabsBefore, "run never ran");
});
test("a background Ardia runs nothing from the menu bar: native items are refused, and an Ardia command gets exactly run's background answer", async () => {
  const { windowId } = await freshWindow();
  const minimize = item([5, 0], "Minimize", { action: "performMiniaturize:", ref: "sel:performMiniaturize:@Window\u001fMinimize" });
  const sidebar = item([1, 0], "Toggle Sidebar", { command: "toggleSidebar", ref: "cmd:toggleSidebar@View\u001fToggle Sidebar" });
  const print = item([1, 9], "Print…", { command: "print", ref: "cmd:print@File\u001fPrint…" });
  stub.surfaces.bar = [item([1], "File", { submenu: [sidebar, print] }), item([5], "Window", { submenu: [minimize] })];
  stub.surfaces.performed.length = 0;
  surfacesModule.surfaceRunMode.background = true;
  try {
    const refused = await call("menus.runBar", { path: minimize.path, ref: minimize.ref, window: windowId });
    assert.equal(refused.error?.code, "refused");
    assert.match(refused.error.message, /background Ardia runs no native menu item/);
    assert.deepEqual(stub.surfaces.performed, []);
    assert.equal((await call("menus.runBar", { path: print.path, ref: print.ref, window: windowId })).error?.code, "refused", "needs the person");
    const direct = runMethod({ command: "toggleSidebar", arg: null, window: windowId, tab: null }, true);
    const viaBar = await call("menus.runBar", { path: sidebar.path, ref: sidebar.ref, window: windowId });
    assert.ok("error" in direct, "run refuses every command in a background Ardia");
    assert.deepEqual(viaBar.error, direct.error);
  } finally {
    surfacesModule.surfaceRunMode.background = false;
  }
});

test("a dropped capture sends clients nothing", async () => {
  const { windowId, tab } = await freshWindow();
  await ok("subscribe", { events: ["menu.opened"] });
  stub.controlSocket.broadcasts.length = 0;
  stub.surfaces.emit({ type: "menuOpened", id: "dr1", kind: "page", captured: true, tab, window: windowId, items: [] });
  stub.surfaces.emit({ type: "menuDropped", id: "dr1", kind: "page" });
  const events = stub.controlSocket.broadcasts.map((b) => JSON.parse(b.line).event);
  assert.deepEqual(events, ["menu.opened"]);
  await ok("subscribe", { events: [] });
});

test("Open File isn't in commands, and run refuses it before resolving a window, never no_window", async () => {
  await freshWindow();
  assert.equal((await ok("commands")).some((c) => c.id === "openFile"), false);
  for (const id of [...S().windowOrder]) S().closeWindow(id, { keepsLastWindow: true });
  S().createWindow({ kind: "private", url: "https://p.example/" });
  const reply = await call("run", { command: "openFile" });
  assert.equal(reply.error?.code, "refused");
  assert.match(reply.error.message, /needs the person to finish it/);
  const runBar = surfacesModule.SURFACE_METHODS.find((m) => m.name === "menus.runBar").description;
  for (const refusal of [/Open File/, /private window/, /background Ardia/]) assert.match(runBar, refusal);
});
