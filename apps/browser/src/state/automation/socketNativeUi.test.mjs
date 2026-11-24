import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { methodSpec, accessProblem, familyOf } = await import("./socketCatalog.ts");
const { usePages, patchPage } = await import("../tabs/pageState.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const stub = await import("../../test-native/index.ts");
const { showPasswordPrompt } = await import("../site/prompts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-test");

const { call, ok } = socketClient(31);

async function promptOn(tab, id, permissions) {
  const { startPermissionPrompts } = await import("../site/permissions.ts");
  startPermissionPrompts();
  stub.emitPermission({ id, tabId: tab, origin: "https://cam.example", permissions });
  await tick();
}

test("a permission prompt on screen is listed, and answering it is refused until the engine reports results", async () => {
  const { windowId, tab } = await freshWindow("https://cam.example/");
  await promptOn(tab, "p10", ["camera"]);
  await promptOn(tab, "p11", ["notifications"]);
  const listed = await ok("permissions.prompts");
  assert.deepEqual(listed, [{ id: "p10", window: windowId, tab, origin: "https://cam.example", permissions: ["camera"], queued: 1 }]);
  stub.resolvedPermissions.length = 0;
  for (const decision of ["allow", "allowOnce", "block", "dismiss"]) {
    const reply = await call("permissions.respond", { id: "p10", decision });
    assert.equal(reply.error.code, "refused", decision);
    assert.match(reply.error.message, /ac_permissions\.mm/);
  }
  assert.deepEqual(stub.resolvedPermissions, []);
  assert.equal(usePages.getState().pages[tab].permission.id, "p10");
  assert.equal((await call("permissions.respond", { id: "p99", decision: "allow" })).error.code, "no_window");
  assert.equal((await call("permissions.respond", { id: "p10", decision: "maybe" })).error.code, "bad_request");
});
test("a prompt in a private window stays invisible", async () => {
  await freshWindow();
  const priv = S().createWindow({ kind: "private", url: "https://cam.example/" });
  const tab = S().windows[priv].activeTabIds[S().windows[priv].profileId];
  await promptOn(tab, "p30", ["camera"]);
  assert.deepEqual(await ok("permissions.prompts"), []);
  assert.equal((await call("permissions.respond", { id: "p30", decision: "allow" })).error.code, "no_window");
});

test("password prompts are listed but not answered, and autofill prompts are answered with their own buttons", async () => {
  const { tab } = await freshWindow("https://login.example/");
  const answers = [];
  webviews.set(tab, {
    resolvePasswordPrompt: (...a) => answers.push(["password", ...a]),
    answerAutofillPrompt: async (...a) => (answers.push(["autofill", ...a]), true),
  });
  showPasswordPrompt(tab, { state: "update", origin: "https://login.example", username: "me", passwordLength: 9, federation: "", usernames: ["me", "you"] });
  const [row] = await ok("passwords.prompts");
  assert.equal(row.state, "update");
  assert.equal("passwordLength" in row, false);
  assert.deepEqual(row.usernames.map((u) => u.name), ["me", "you"]);
  const reply = await call("passwords.respond", { tab, id: row.id, decision: "update", usernameId: row.usernames[1].id });
  assert.equal(reply.error.code, "refused");
  assert.match(reply.error.message, /ac_password_prompt\.mm/);
  assert.deepEqual(answers, []);
  assert.ok(usePages.getState().pages[tab].passwordPrompt);
  patchPage(tab, { autofillPrompt: { id: 4, kind: "saveCard", origin: "https://login.example", title: "Save card?", message: "", accept: "Save", decline: "No thanks", footer: "", lines: ["Visa 1234"] } });
  const [card] = await ok("autofill.prompts");
  assert.equal("lines" in card, false);
  await ok("autofill.respond", { tab, id: 4, decision: "decline" });
  assert.deepEqual(answers.at(-1), ["autofill", 4, "decline"]);
  assert.equal((await call("autofill.respond", { tab, id: 4, decision: "accept" })).error.code, "no_window");
  webviews.delete(tab);
});
test("open menus are listed and closed through the native menu, and page menus are never chosen from", async () => {
  const { windowId, tab } = await freshWindow();
  stub.surfaces.open = [
    { id: "m1", kind: "select", tab, window: windowId, items: [{ path: [0], title: "apple", enabled: true, checked: true, separator: false }] },
    { id: "m2", kind: "page", captured: true, tab, window: windowId, items: [] },
    { id: "m3", kind: "menuBar", window: windowId, items: [] },
  ];
  const open = await ok("menus.open");
  assert.deepEqual(open.map((m) => [m.id, m.window, m.tab]), [["m2", windowId, tab]], "only a captured page menu is listed");
  assert.equal((await call("menus.choose", { menu: "m1", path: [] })).error.code, "bad_request");
  assert.equal((await call("menus.choose", { menu: "m1", path: [0] })).error.code, "no_window");
  assert.equal((await call("menus.choose", { menu: "m2", path: [0] })).error.code, "refused");
  await ok("menus.dismiss", { menu: "m2" });
  assert.deepEqual(await ok("menus.open"), []);
});

test("a page's menu in a private window is not listed", async () => {
  await freshWindow();
  const priv = S().createWindow({ kind: "private", url: "https://p.example/" });
  const tab = S().windows[priv].activeTabIds[S().windows[priv].profileId];
  stub.surfaces.open = [{ id: "m4", kind: "page", captured: true, tab, window: priv, items: [] }, { id: "m5", kind: "select", window: priv, items: [] }];
  assert.deepEqual(await ok("menus.open"), []);
  assert.equal((await call("menus.dismiss", { menu: "m4" })).error.code, "no_window");
});

test("menus.runBar runs a catalog item by its ref: Ardia commands through run with no validation, other items to their native target", async () => {
  const { windowId } = await freshWindow();
  stub.surfaces.bar = [
    {
      path: [1],
      title: "File",
      ref: "menu@File",
      separator: false,
      submenu: [
        { path: [1, 0], ref: "cmd:newTab@File\u001fNew Tab", title: "New Tab", separator: false, command: "newTab" },
        { path: [1, 2], ref: "cmd:newWindow@File\u001fNew Window", title: "New Window", separator: false, command: "newWindow" },
        { path: [1, 3], ref: "dynamic@menu@File\u001fShare", title: "Share", separator: false, dynamic: true },
      ],
    },
    { path: [2], title: "Edit", ref: "menu@Edit", separator: false, submenu: [{ path: [2, 0], ref: "sel:copy:@Edit\u001fCopy", title: "Copy", separator: false, action: "copy:" }] },
  ];
  const tabsBefore = Object.values(S().tabs).filter((t) => t.windowId === windowId).length;
  assert.deepEqual(await ok("menus.runBar", { path: [1, 0], ref: "cmd:newTab@File\u001fNew Tab", window: windowId }), { ok: true, title: "New Tab", command: "newTab" });
  await tick();
  assert.ok(Object.values(S().tabs).filter((t) => t.windowId === windowId).length > tabsBefore, "run opened a tab");
  assert.equal((await call("menus.runBar", { path: [1, 1], ref: "cmd:newTab@File\u001fNew Tab" })).error.code, "no_window", "path and ref must agree");
  assert.equal((await call("menus.runBar", { path: [1, 1], ref: "x" })).error.code, "no_window");
  const dynamic = await call("menus.runBar", { path: [1, 3], ref: "dynamic@menu@File\u001fShare" });
  assert.equal(dynamic.error.code, "refused");
  assert.match(dynamic.error.message, /built from open windows/);
  assert.equal((await call("menus.runBar", { path: [1], ref: "menu@File" })).error.code, "no_window");
  assert.deepEqual(await ok("menus.runBar", { path: [2, 0], ref: "sel:copy:@Edit\u001fCopy", window: windowId }), { ok: true, title: "performed", action: "copy:" });
  assert.deepEqual(stub.surfaces.performed.at(-1), { ref: "sel:copy:@Edit\u001fCopy", windowId });
  assert.equal((await ok("menus.bar")).length, 2);
});
test("menu and prompt events reach subscribers", async () => {
  const { windowId, tab } = await freshWindow("https://cam.example/");
  await ok("subscribe", { events: ["menu.opened", "permission.prompted"] });
  stub.controlSocket.broadcasts.length = 0;
  stub.surfaces.emit({ type: "menuOpened", id: "m9", kind: "page", captured: true, tab, window: windowId, items: [{ path: [0] }, { path: [1] }] });
  await promptOn(tab, "p40", ["camera"]);
  const events = stub.controlSocket.broadcasts.map((b) => JSON.parse(b.line));
  assert.deepEqual(events.map((e) => e.event), ["menu.opened", "permission.prompted"]);
  assert.equal(events[0].data.items, 2);
  assert.equal(events[1].data.id, "p40");
  await ok("subscribe", { events: [] });
});

test("plugin sessions can't reach the native UI methods, and each family counts", async () => {
  await freshWindow();
  for (const name of ["permissions.prompts", "permissions.respond", "passwords.respond", "autofill.respond", "menus.open", "menus.choose", "menus.dismiss", "menus.bar", "menus.runBar"]) {
    assert.equal(accessProblem("plugin", methodSpec(name))?.code, "refused", name);
  }
  assert.equal(familyOf("menus.open"), "menus");
  assert.equal(familyOf("permissions.respond"), "permissions");
  takeCliCounts();
  stub.surfaces.open = [];
  await ok("menus.open");
  await ok("permissions.prompts");
  await call("menus.dismiss", { menu: "nope" });
  const counts = takeCliCounts();
  assert.equal(counts.cli_socket_calls_menus, 2);
  assert.equal(counts.cli_socket_calls_permissions, 1);
  assert.equal(counts.cli_socket_call_failures, 1);
});

test("the socket captures a hidden page's context menu only while it serves", async () => {
  await freshWindow();
  for (let i = 0; i < 10 && !stub.surfaces.captures; i++) await tick();
  assert.equal(stub.surfaces.captures, true);
  S().updateSettings({ cliControl: false });
  for (let i = 0; i < 10 && stub.surfaces.captures; i++) await tick();
  assert.equal(stub.surfaces.captures, false);
});
