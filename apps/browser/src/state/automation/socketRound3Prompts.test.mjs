import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const { runMethod } = await import("./controlSocket.ts");
const { patchPage } = await import("../tabs/pageState.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const stub = await import("../../test-native/index.ts");

const dialogs = shellNativeModules.ArdiaDialogs;
const appWindows = shellNativeModules.ArdiaAppWindows;
const originalConfirm = dialogs.confirm;
const originalAnimate = appWindows.animateWindowClose;
after(() => {
  dialogs.confirm = originalConfirm;
  appWindows.animateWindowClose = originalAnimate;
  delete globalThis.acTestUserScripts;
  S().updateSettings({ cliControl: false });
});

const { fire, call } = socketClient(81);
const other = socketClient(82);
const asked = [];

function unseen() {
  asked.length = 0;
  dialogs.confirm = (options) => (asked.push(options), Promise.resolve(options.onlyIfShown ? { confirmed: false, suppressed: false, unshown: true } : { confirmed: true, suppressed: false }));
}

function holdAnimations() {
  const finishing = new Map();
  appWindows.animateWindowClose = (id) => new Promise((resolve) => finishing.set(id, resolve));
  return finishing;
}

test("two closes whose animations finish in reverse order keep exactly one window to reopen", async () => {
  const { windowId: first } = await freshWindow();
  const second = S().createWindow({ url: "https://two.example/" });
  S().updateSettings({ warnBeforeClosingWindow: false });
  const closedBefore = S().closedWindows.length;
  const finishing = holdAnimations();
  try {
    const closes = [fire("windows.close", { window: first }), other.fire("windows.close", { window: second })];
    for (let i = 0; i < 50 && finishing.size < 2; i++) await tick();
    assert.equal(finishing.size, 2, "both animations started");
    finishing.get(second)();
    for (let i = 0; i < 10; i++) await tick();
    finishing.get(first)();
    for (const reply of await Promise.all(closes)) assert.ok(!reply.error, JSON.stringify(reply.error));
    const closed = S().closedWindows.slice(closedBefore);
    assert.equal(closed.length, 2);
    assert.equal(closed.filter((c) => c.lastWindow).length, 1, "the one that closed last is kept to reopen");
  } finally {
    appWindows.animateWindowClose = originalAnimate;
  }
});

test("once the native close has started, turning control off still finishes the store close", async () => {
  const { windowId } = await freshWindow();
  S().createWindow({ url: "https://other.example/" });
  S().updateSettings({ warnBeforeClosingWindow: false });
  const finishing = holdAnimations();
  try {
    const closing = fire("windows.close", { window: windowId });
    for (let i = 0; i < 50 && !finishing.size; i++) await tick();
    S().updateSettings({ cliControl: false });
    finishing.get(windowId)();
    const reply = await closing;
    assert.equal(S().windows[windowId], undefined, "no hidden window is left in the store");
    assert.equal(reply.result?.ok, true, "the close happened, so the reply says so");
  } finally {
    appWindows.animateWindowClose = originalAnimate;
  }
});

test("profiles.delete asks only where the question can be seen, and refuses otherwise", async () => {
  await freshWindow();
  const work = S().createProfile({ name: "Work" });
  unseen();
  const reply = await call("profiles.delete", { profile: work });
  assert.equal(reply.error?.code, "refused");
  assert.equal(asked[0]?.onlyIfShown, true);
  assert.ok(S().profiles[work]);
  dialogs.confirm = originalConfirm;
});

test("extensions.uninstall asks only where the question can be seen, and refuses otherwise", async () => {
  await freshWindow();
  const uninstalled = [];
  const ext = { id: "abcdefghijklmnopabcdefghijklmnop", name: "Ext", version: "1", enabled: true, state: "ENABLED", mayModify: true, fromWebStore: true, pinned: false, icon: null, description: "" };
  globalThis.acTestUserScripts = { engine: { list: async () => (uninstalled.length ? [] : [ext]), install: async () => "x", reload: async () => {}, uninstall: async (id) => void uninstalled.push(id) } };
  unseen();
  const reply = await call("extensions.uninstall", { id: ext.id });
  assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
  assert.equal(asked[0]?.onlyIfShown, true);
  assert.deepEqual(uninstalled, []);
  dialogs.confirm = originalConfirm;
});

test("tabs.back across engines asks only where it can be seen and replies after the answer", async () => {
  const { tab } = await freshWindow();
  S().updateTab(tab, { page: { kind: "loaded", navigation: null } });
  patchPage(tab, { engineBack: { engine: "webkit", url: "https://prev.example/" } });
  webviews.set(tab, { evaluate: async () => true, goBack: () => {} });
  try {
    unseen();
    const refused = await call("tabs.back", { tab });
    assert.equal(refused.error?.code, "refused", JSON.stringify(refused));
    assert.equal(asked[0]?.onlyIfShown, true);

    const waiting = [];
    dialogs.confirm = () => new Promise((resolve) => waiting.push(resolve));
    const before = stubReplies();
    const going = fire("tabs.back", { tab });
    for (let i = 0; i < 50 && !waiting.length; i++) await tick();
    assert.equal(waiting.length, 1, "Ardia asked");
    assert.equal(stubReplies(), before, "no reply before the answer");
    waiting[0]({ confirmed: false, suppressed: false });
    assert.equal((await going).error?.code, "refused", "Stay on Page answers refused");
  } finally {
    webviews.delete(tab);
    dialogs.confirm = originalConfirm;
  }
});

test("run refuses a command that would ask in a background instance, before running it", async () => {
  const { windowId } = await freshWindow();
  S().updateSettings({ warnBeforeClosingLastTab: true });
  unseen();
  const refused = runMethod({ command: "closeTab", window: windowId }, true);
  assert.equal(refused.error?.code, "refused");
  for (let i = 0; i < 10; i++) await tick();
  assert.ok(S().windows[windowId], "nothing ran");
  assert.equal(asked.length, 0);
  S().newTab(windowId, { url: "https://second.example/" });
  const tabs = S().windows[windowId].tabIds;
  assert.equal(runMethod({ command: "closeTab", window: windowId }, true).error?.code, "refused", "closeTab may ask, so a background run never takes it; apply's tab.close does");
  const group = S().createGroup([tabs.at(-1)]);
  S().activate(tabs.at(-1));
  assert.equal(runMethod({ command: "closeTabGroup", window: windowId }, true).error?.code, "refused");
  assert.ok(tabs.every((id) => S().tabs[id]) && S().groups[group], "nothing closed");
  dialogs.confirm = originalConfirm;
});

const stubReplies = () => stub.controlSocket.replies.filter((r) => r.connection === 81).length;
