import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-round5-test");

const { call, ok } = socketClient(36);

const item = (path, title, more) => ({ path, title, enabled: true, checked: false, separator: false, ...more });
const openFile = item([1, 6], "Open File…", { command: "openFile", ref: "cmd:openFile@File\u001fOpen File…" });
const minimize = item([5, 0], "Minimize", { action: "performMiniaturize:", ref: "sel:performMiniaturize:@Window\u001fMinimize" });

test("the socket never starts Open File, through run, menus.runBar or a menu bar choice", async () => {
  const { windowId } = await freshWindow();
  stub.surfaces.bar = [item([1], "File", { submenu: [openFile] })];
  stub.surfaces.open = [{ id: "of1", kind: "menuBar", window: windowId, items: [openFile] }];
  const replies = [
    await call("run", { command: "openFile", window: windowId }),
    await call("run", { command: "openFile" }),
    await call("menus.runBar", { path: openFile.path, ref: openFile.ref, window: windowId }),
  ];
  for (const reply of replies) assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
  for (const reply of replies) assert.match(reply.error.message, /needs the person to finish it/);
});

test("the menu bar is refused while a private window is open in the background behind a regular key window", async () => {
  const { windowId } = await freshWindow();
  const priv = S().createWindow({ kind: "private", url: "https://p.example/" });
  const regular = S().createWindow({ url: "https://b.example/" });
  stub.surfaces.bar = [item([5], "Window", { submenu: [minimize] })];
  stub.surfaces.open = [{ id: "bg1", kind: "menuBar", window: regular, items: [minimize] }];
  const bar = await call("menus.bar");
  assert.equal(bar.error?.code, "refused");
  assert.match(bar.error.message, /private window is open/);
  assert.deepEqual(await ok("menus.open"), [], "no tracked bar is listed");
  assert.equal((await call("menus.choose", { menu: "bg1", path: minimize.path, ref: minimize.ref })).error?.code, "no_window");
  assert.equal((await call("menus.runBar", { path: minimize.path, ref: minimize.ref, window: regular })).error?.code, "refused");
  assert.ok(priv && windowId);
});

test("switching focus from the private window to a regular one keeps the menu bar refused while the private window exists", async () => {
  const { windowId } = await freshWindow();
  const priv = S().createWindow({ kind: "private", url: "https://p.example/" });
  stub.surfaces.bar = [item([5], "Window", { submenu: [minimize] })];
  assert.equal((await call("menus.bar")).error?.code, "refused");
  S().createWindow({ url: "https://c.example/" });
  await tick();
  assert.equal((await call("menus.bar")).error?.code, "refused", "still refused after the regular window takes focus");
  S().closeWindow(priv, { keepsLastWindow: true });
  await tick();
  assert.ok(Array.isArray(await ok("menus.bar")), "answered once the private window is gone");
  assert.ok(windowId);
});

test("picks from a page's menu or a <select> popup are refused on every route, and never reach native", async () => {
  const { windowId, tab } = await freshWindow();
  stub.surfaces.open = [
    { id: "pg1", kind: "page", tab, window: windowId, items: [item([0], "Share", { command: 7 })] },
    { id: "sl1", kind: "select", tab, window: windowId, items: [item([0], "apple")] },
  ];
  stub.surfaces.chosen.length = 0;
  assert.deepEqual(await ok("menus.open"), [], "neither a context menu on screen nor a select popup has a proven source");
  for (const menu of ["pg1", "sl1"]) assert.equal((await call("menus.choose", { menu, path: [0] })).error?.code, "no_window", menu);
  assert.deepEqual(stub.surfaces.chosen, []);
});
