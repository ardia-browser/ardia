import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { usePages } = await import("../tabs/pageState.ts");
const { webviews } = await import("../../platform/webviews.ts");
const stub = await import("../../test-native/index.ts");
const { showPasswordPrompt } = await import("../site/prompts.ts");
const { startPermissionPrompts } = await import("../site/permissions.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-round3-test");

const { call, ok } = socketClient(34);

const item = (path, title, more) => ({ path, title, enabled: true, checked: false, separator: false, ...more });

test("a captured page menu is listed, and every pick from it is refused without reaching native", async () => {
  const { windowId, tab } = await freshWindow();
  stub.surfaces.open = [{ id: "c1", kind: "page", captured: true, tab, window: windowId, items: [item([0], "Select All", { command: 50156 })] }];
  stub.surfaces.chosen.length = 0;
  assert.equal((await ok("menus.open"))[0].id, "c1");
  const reply = await call("menus.choose", { menu: "c1", path: [0] });
  assert.equal(reply.error?.code, "refused");
  assert.match(reply.error.message, /runContextMenuCommand/);
  assert.deepEqual(stub.surfaces.chosen, []);
  assert.deepEqual((await ok("menus.open")).map((m) => m.id), ["c1"], "the menu stays listed");
});

test("passwords.respond is refused for the prompt on screen, naming the engine work", async () => {
  const { tab } = await freshWindow("https://login.example/");
  const answers = [];
  webviews.set(tab, { resolvePasswordPrompt: (...a) => answers.push(a), answerPasswordPrompt: async (...a) => (answers.push(a), true) });
  showPasswordPrompt(tab, { state: "save", origin: "https://login.example", username: "a", passwordLength: 4, federation: "", usernames: [] });
  const [row] = await ok("passwords.prompts");
  for (const decision of ["save", "never", "notNow", "dismiss"]) {
    const reply = await call("passwords.respond", { tab, id: row.id, decision });
    assert.equal(reply.error?.code, "refused", decision);
    assert.match(reply.error.message, /ac_password_prompt\.mm/);
  }
  assert.deepEqual(answers, []);
  assert.ok(usePages.getState().pages[tab].passwordPrompt, "the prompt stays for the person");
  webviews.delete(tab);
});

test("permissions.respond is refused for every decision, and the prompt stays queued", async () => {
  const { tab } = await freshWindow("https://cam.example/");
  startPermissionPrompts();
  stub.emitPermission({ id: "r1", tabId: tab, origin: "https://cam.example/", permissions: ["camera"] });
  await tick();
  stub.resolvedPermissions.length = 0;
  for (const decision of ["allow", "block", "allowOnce", "dismiss"]) {
    const reply = await call("permissions.respond", { id: "r1", decision });
    assert.equal(reply.error?.code, "refused", decision);
    assert.match(reply.error.message, /ac_permissions\.mm/);
  }
  assert.deepEqual(stub.resolvedPermissions, []);
  assert.equal(usePages.getState().pages[tab].permission.id, "r1");
});

test("username ids are tokens of the prompt and the username, never reusable positions", async () => {
  const { tab } = await freshWindow("https://login.example/");
  const usernames = Array.from({ length: 30 }, (_, i) => `user${i}`);
  showPasswordPrompt(tab, { state: "update", origin: "https://login.example", username: "user0", passwordLength: 4, federation: "", usernames });
  const [first] = await ok("passwords.prompts");
  showPasswordPrompt(tab, { state: "update", origin: "https://login.example", username: "user0", passwordLength: 4, federation: "", usernames: ["other", "user1"] });
  const [second] = await ok("passwords.prompts");
  assert.ok(first.usernames.every((u) => /^u-[0-9a-f]{16}$/.test(u.id)));
  assert.notEqual(first.usernames[1].id, second.usernames[1].id, "the same position in another prompt is another id");
  assert.notEqual(first.usernames[1].id, second.usernames[0].id);
  assert.equal(new Set(first.usernames.map((u) => u.id)).size, first.usernames.length);
  for (const usernameId of [first.usernames[1].id, "u20", "u1"]) {
    assert.equal((await call("passwords.respond", { tab, id: second.id, decision: "update", usernameId })).error?.code, "refused", usernameId);
  }
});
