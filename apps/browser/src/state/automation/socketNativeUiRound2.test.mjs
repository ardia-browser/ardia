import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { usePages } = await import("../tabs/pageState.ts");
const { webviews } = await import("../../platform/webviews.ts");
const stub = await import("../../test-native/index.ts");
const { showAutofillPrompt, answerAutofillPrompt } = await import("../site/prompts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-round2-test");

const { call, ok } = socketClient(33);

const item = (path, title, more) => ({ path, title, enabled: true, checked: false, separator: false, ...more });

test("the on-screen autofill buttons answer only the prompt they were drawn for", async () => {
  const { tab } = await freshWindow("https://shop.example/");
  const answers = [];
  webviews.set(tab, { resolveAutofillPrompt: (...a) => answers.push(a) });
  const card = (id) => ({ id, kind: "saveCard", origin: "https://shop.example", title: "", message: "", accept: "", decline: "", footer: "", lines: [] });
  showAutofillPrompt(tab, card(3), 3);
  showAutofillPrompt(tab, card(4), 4);
  assert.equal(answerAutofillPrompt(tab, "accept", 3), false);
  assert.deepEqual(answers, []);
  assert.equal(answerAutofillPrompt(tab, "decline", 4), true);
  assert.deepEqual(answers, [[4, "decline"]]);
  webviews.delete(tab);
});

test("Minimize All and Arrange in Front are refused while a private window is open, and allowed otherwise", async () => {
  const { windowId } = await freshWindow();
  const minimizeAll = item([5, 1], "Minimize All", { action: "miniaturizeAll:", ref: "sel:miniaturizeAll:@Window\u001fMinimize All" });
  const arrange = item([5, 3], "Arrange in Front", { action: "arrangeWindowsInFront:", ref: "sel:arrangeWindowsInFront:@Window\u001fArrange in Front" });
  stub.surfaces.bar = [item([5], "Window", { submenu: [minimizeAll, arrange] })];
  stub.surfaces.performed.length = 0;
  await ok("menus.runBar", { path: minimizeAll.path, ref: minimizeAll.ref, window: windowId });
  assert.equal(stub.surfaces.performed.length, 1);
  S().createWindow({ kind: "private", url: "https://p.example/" });
  for (const it of [minimizeAll, arrange]) assert.equal((await call("menus.runBar", { path: it.path, ref: it.ref, window: windowId })).error.code, "refused");
  assert.equal(stub.surfaces.performed.length, 1);
});

test("turning control off while the catalog is read stops a menu bar command before run", async () => {
  const { windowId } = await freshWindow();
  const newTab = item([1, 0], "New Tab", { command: "newTab", ref: "cmd:newTab@File\u001fNew Tab" });
  stub.surfaces.bar = [item([1], "File", { ref: "menu@File", submenu: [newTab] })];
  const tabsBefore = Object.keys(S().tabs).length;
  stub.surfaces.barHook = () => S().updateSettings({ cliControl: false });
  const reply = await call("menus.runBar", { path: newTab.path, ref: newTab.ref, window: windowId });
  stub.surfaces.barHook = null;
  assert.equal(reply.error?.code, "failed");
  await tick();
  assert.equal(Object.keys(S().tabs).length, tabsBefore, "run never ran");
});
