import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { usePages, patchPage } = await import("../tabs/pageState.ts");
const { webviews } = await import("../../platform/webviews.ts");
const stub = await import("../../test-native/index.ts");
const { showPasswordPrompt, showAutofillPrompt } = await import("../site/prompts.ts");
const { startPermissionPrompts } = await import("../site/permissions.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-rules-test");

const { call, ok } = socketClient(32);

const item = (path, title, more) => ({ path, title, enabled: true, checked: false, separator: false, ...more });

function trackingMenuBar(windowId) {
  const quit = item([0, 5], "Quit Ardia", { action: "terminate:", ref: "sel:terminate:@Ardia\u001fQuit Ardia" });
  const appleEvents = item([3, 7], "Allow JavaScript from Apple Events", {
    command: "toggleJavaScriptFromAppleEvents",
    ref: "cmd:toggleJavaScriptFromAppleEvents@View\u001fDeveloper\u001fAllow JavaScript from Apple Events",
  });
  const selectAll = item([2, 4], "Select All", { action: "selectAll:", ref: "sel:selectAll:@Edit\u001fSelect All" });
  stub.surfaces.bar = [
    item([0], "Ardia", { submenu: [quit] }),
    item([2], "Edit", { submenu: [selectAll] }),
    item([3], "View", { submenu: [appleEvents] }),
  ];
  stub.surfaces.open = [{ id: "bar1", kind: "menuBar", window: windowId, items: stub.surfaces.bar }];
  return { quit, appleEvents, selectAll };
}

test("a tracking menu bar isn't listed, and nothing is chosen from it", async () => {
  const { windowId } = await freshWindow();
  const { quit, appleEvents, selectAll } = trackingMenuBar(windowId);
  stub.surfaces.chosen.length = 0;
  stub.surfaces.performed.length = 0;
  assert.deepEqual(await ok("menus.open"), []);
  for (const it of [quit, appleEvents, selectAll]) {
    const reply = await call("menus.choose", { menu: "bar1", path: it.path, ref: it.ref });
    assert.equal(reply.error?.code, "no_window", it.title);
  }
  assert.deepEqual(stub.surfaces.performed, []);
  assert.equal((await call("menus.dismiss", { menu: "bar1" })).error?.code, "no_window");
});
test("Ardia's own menus and unknown menus are refused, and runBar needs a ref", async () => {
  const { windowId } = await freshWindow();
  stub.surfaces.open = [
    { id: "app1", kind: "app", window: windowId, items: [item([0], "Copy Recovery Code")] },
    { id: "oth1", kind: "other", window: windowId, items: [item([0], "Something")] },
  ];
  assert.equal((await call("menus.choose", { menu: "app1", path: [0] })).error.code, "no_window");
  assert.equal((await call("menus.choose", { menu: "oth1", path: [0] })).error.code, "no_window");
  assert.equal((await call("menus.runBar", { path: [2, 4] })).error.code, "bad_request");
});

test("a password answer is refused: for a replaced prompt as closed, for the current one until the engine names offers", async () => {
  const { tab } = await freshWindow("https://login.example/");
  const answers = [];
  webviews.set(tab, { resolvePasswordPrompt: (...a) => answers.push(a) });
  showPasswordPrompt(tab, { state: "save", origin: "https://login.example", username: "a", passwordLength: 4, federation: "", usernames: [] });
  const [first] = await ok("passwords.prompts");
  showPasswordPrompt(tab, { state: "update", origin: "https://login.example", username: "b", passwordLength: 4, federation: "", usernames: [] });
  const [second] = await ok("passwords.prompts");
  assert.notEqual(first.id, second.id);
  assert.equal((await call("passwords.respond", { tab, id: first.id, decision: "update" })).error.code, "no_window");
  assert.equal((await call("passwords.respond", { tab, id: second.id, decision: "update" })).error.code, "refused");
  assert.deepEqual(answers, []);
  webviews.delete(tab);
});
test("an autofill answer for a replaced prompt is refused, and a native refusal is a failure", async () => {
  const { tab } = await freshWindow("https://shop.example/");
  let accepts = true;
  const answers = [];
  webviews.set(tab, { answerAutofillPrompt: async (...a) => (answers.push(a), accepts) });
  const card = (id) => ({ id, kind: "saveCard", origin: "https://shop.example", title: "", message: "", accept: "", decline: "", footer: "", lines: [] });
  showAutofillPrompt(tab, card(7), 7);
  showAutofillPrompt(tab, card(8), 8);
  assert.equal((await call("autofill.respond", { tab, id: 7, decision: "accept" })).error.code, "no_window");
  accepts = false;
  assert.equal((await call("autofill.respond", { tab, id: 8, decision: "accept" })).error.code, "failed");
  assert.equal(usePages.getState().pages[tab].autofillPrompt.id, 8, "a refused answer leaves the prompt up");
  assert.deepEqual(answers, [[8, "accept"]]);
  webviews.delete(tab);
  assert.equal((await call("autofill.respond", { tab, id: 8, decision: "accept" })).error.code, "no_window", "no page, no answer");
});

test("an update address prompt is described from its fields, never the engine's summary of the address", async () => {
  const { tab } = await freshWindow("https://shop.example/");
  showAutofillPrompt(
    tab,
    {
      id: 11,
      kind: "updateAddress",
      origin: "https://shop.example",
      title: "Update address?",
      message: "Jane Q Public, 742 Evergreen Terrace, Springfield",
      accept: "Update",
      decline: "No thanks",
      footer: "",
      lines: [],
      changes: [
        { field: "address", from: "742 Evergreen Terrace", to: "744 Evergreen Terrace" },
        { field: "phone", from: "555-0100", to: "555-0199" },
      ],
    },
    11,
  );
  const listed = await ok("autofill.prompts");
  const text = JSON.stringify(listed);
  for (const secret of ["Evergreen", "Jane", "555-0"]) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(listed[0].fields, ["address", "phone"]);
  assert.equal(listed[0].kind, "updateAddress");
  assert.equal(listed[0].description, "Update a saved address: address, phone change");
});

test("every permission decision is refused, whatever the kinds", async () => {
  for (const [id, permissions] of [["o1", []], ["o2", ["camera", "notifications"]], ["o3", ["camera"]]]) {
    const { tab } = await freshWindow("https://cam.example/");
    startPermissionPrompts();
    stub.emitPermission({ id, tabId: tab, origin: "https://cam.example", permissions });
    await tick();
    for (const decision of ["allowOnce", "allow"]) assert.equal((await call("permissions.respond", { id, decision })).error.code, "refused", `${id} ${decision}`);
  }
});
test("password prompts list at most 20 usernames with the full count, in replies and events", async () => {
  const { tab } = await freshWindow("https://login.example/");
  await ok("subscribe", { events: ["password.prompted"] });
  stub.controlSocket.broadcasts.length = 0;
  const usernames = Array.from({ length: 50 }, (_, i) => `user${i}-${"x".repeat(400)}`);
  showPasswordPrompt(tab, { state: "update", origin: "https://login.example", username: "user0", passwordLength: 4, federation: "", usernames });
  await tick();
  const [row] = await ok("passwords.prompts");
  assert.equal(row.usernames.length, 20);
  assert.equal(row.usernameCount, 50);
  assert.ok(row.usernames.every((u) => /^u-[0-9a-f]{16}$/.test(u.id) && u.name.length <= 256));
  const event = stub.controlSocket.broadcasts.map((b) => JSON.parse(b.line)).find((e) => e.event === "password.prompted");
  assert.equal(event.data.usernames.length, 20);
  assert.equal(event.data.usernameCount, 50);
  await ok("subscribe", { events: [] });
  patchPage(tab, { passwordPrompt: null });
});
