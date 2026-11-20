import assert from "node:assert/strict";
import { test } from "node:test";
const { socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-round8-test");

const { call, ok } = socketClient(39);

test("a page's context menu on screen isn't listed, and dismissing it answers as an unknown id does, while a captured one is listed", async () => {
  const { windowId, tab } = await freshWindow();
  stub.surfaces.open = [
    { id: "lv1", kind: "page", tab, window: windowId, items: [{ path: [0], title: "Copy", enabled: true, checked: false, separator: false }] },
    { id: "cp1", kind: "page", captured: true, tab, window: windowId, items: [] },
  ];
  stub.surfaces.dismissed.length = 0;
  assert.deepEqual((await ok("menus.open")).map((m) => m.id), ["cp1"]);
  const live = await call("menus.dismiss", { menu: "lv1" });
  const unknown = await call("menus.dismiss", { menu: "zz9" });
  assert.equal(live.error?.code, "no_window");
  assert.deepEqual(live.error, unknown.error);
  assert.deepEqual(stub.surfaces.dismissed, []);
});
test("Bookmark All Tabs and Rename Tab need the person: absent from commands and refused by run", async () => {
  const { windowId } = await freshWindow();
  const listed = new Set((await ok("commands")).map((c) => c.id));
  for (const command of ["bookmarkAllTabs", "renameTab"]) {
    assert.equal(listed.has(command), false, command);
    const reply = await call("run", { command, window: windowId });
    assert.equal(reply.error?.code, "refused", command);
    assert.equal(reply.error.message, `${command} needs the person to finish it, so the ardia command can't run it.`);
  }
});

test("menus.runBar applies the command policy before it resolves the window, as run does", async () => {
  await freshWindow();
  const print = { path: [1, 9], title: "Print…", separator: false, ref: "cmd:print@File\u001fPrint…", command: "print" };
  stub.surfaces.bar = [{ path: [1], title: "File", separator: false, ref: "menu@File", submenu: [print] }];
  const viaBar = await call("menus.runBar", { path: print.path, ref: print.ref, window: "w-gone" });
  const viaRun = await call("run", { command: "print", window: "w-gone" });
  assert.equal(viaBar.error?.code, "refused");
  assert.match(viaBar.error.message, /needs the person/);
  assert.deepEqual(viaBar.error, viaRun.error);
});

test("menus.choose isn't advertised in methods, and calling it is still refused", async () => {
  const { windowId, tab } = await freshWindow();
  assert.equal((await ok("methods")).some((m) => m.name === "menus.choose"), false);
  stub.surfaces.open = [{ id: "s9", kind: "page", captured: true, tab, window: windowId, items: [] }];
  assert.equal((await call("menus.choose", { menu: "s9", path: [0] })).error?.code, "refused");
});
