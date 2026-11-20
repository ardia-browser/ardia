import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-round7-test");

const { call, ok } = socketClient(38);

const CATALOG = [
  {
    path: [1],
    title: "File",
    ref: "menu@File",
    separator: false,
    submenu: [
      { path: [1, 0], title: "New Tab", ref: "cmd:newTab@File\u001fNew Tab", separator: false, key: "t", command: "newTab" },
      { path: [1, 1], title: "Share", ref: "dynamic@menu@File\u001fShare", separator: false, dynamic: true },
    ],
  },
  { path: [7], title: "History", ref: "dynamic@menu@History", separator: false, dynamic: true },
];

test("menus.bar is the native catalog as given, dynamic rows included, and doesn't change with windows or profiles", async () => {
  await freshWindow();
  stub.surfaces.bar = CATALOG;
  const first = JSON.stringify(await ok("menus.bar"));
  assert.equal(first, JSON.stringify(CATALOG));
  S().createWindow({ url: "https://b.example/" });
  S().createWindow({ url: "https://c.example/" });
  await tick();
  assert.equal(JSON.stringify(await ok("menus.bar")), first);
});

test("an Ardia command from the catalog runs straight through run, with no native validation step", async () => {
  const { windowId } = await freshWindow();
  stub.surfaces.bar = CATALOG;
  const tabsBefore = Object.values(S().tabs).filter((t) => t.windowId === windowId).length;
  assert.deepEqual(await ok("menus.runBar", { path: [1, 0], ref: "cmd:newTab@File\u001fNew Tab", window: windowId }), { ok: true, title: "New Tab", command: "newTab" });
  await tick();
  assert.ok(Object.values(S().tabs).filter((t) => t.windowId === windowId).length > tabsBefore);
});

test("a dynamic row can't be run", async () => {
  const { windowId } = await freshWindow();
  stub.surfaces.bar = CATALOG;
  for (const [path, ref] of [[[1, 1], "dynamic@menu@File\u001fShare"], [[7], "dynamic@menu@History"]]) {
    const reply = await call("menus.runBar", { path, ref, window: windowId });
    assert.equal(reply.error?.code, "refused", ref);
    assert.match(reply.error.message, /built from open windows/);
  }
});

test("menus.open keeps a captured page menu's enabled and checked state, and lists no <select> popup", async () => {
  const { windowId, tab } = await freshWindow();
  stub.surfaces.open = [
    { id: "sel1", kind: "select", tab, window: windowId, items: [{ path: [0], title: "apple", enabled: true, checked: true, separator: false }] },
    {
      id: "pg1",
      kind: "page",
      captured: true,
      tab,
      window: windowId,
      items: [
        { path: [0], title: "Copy", enabled: false, checked: false, separator: false, command: 50150 },
        { path: [1], title: "Spelling", enabled: true, checked: true, separator: false, command: 3 },
      ],
    },
  ];
  const listed = await ok("menus.open");
  assert.deepEqual(listed.map((m) => m.id), ["pg1"]);
  assert.deepEqual(listed[0].items.map((i) => [i.title, i.enabled, i.checked]), [["Copy", false, false], ["Spelling", true, true]]);
});
test("commands that need the person to finish them are left out of commands and refused before any window is resolved", async () => {
  await freshWindow();
  const need = ["exportBookmarks", "savePage", "print", "printWithSystemDialog", "newProfile", "openFile", "clearBrowsingData", "importBrowserData", "share", "cast"];
  const listed = new Set((await ok("commands")).map((c) => c.id));
  for (const command of need) assert.equal(listed.has(command), false, command);
  for (const id of [...S().windowOrder]) S().closeWindow(id, { keepsLastWindow: true });
  S().createWindow({ kind: "private", url: "https://p.example/" });
  for (const command of ["savePage", "print", "newProfile"]) {
    const reply = await call("run", { command });
    assert.equal(reply.error?.code, "refused", command);
    assert.equal(reply.error.message, `${command} needs the person to finish it, so the ardia command can't run it.`);
  }
});
