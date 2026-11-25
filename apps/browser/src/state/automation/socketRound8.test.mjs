import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const { useLifecycle } = await import("../tabs/sleepingTabs.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const stub = await import("../../test-native/index.ts");

const dialogs = shellNativeModules.ArdiaDialogs;
const originals = { confirm: dialogs.confirm, dismiss: dialogs.dismissShownOnly, can: dialogs.dismissesShownOnly };
const restore = () => Object.assign(dialogs, { confirm: originals.confirm, dismissShownOnly: originals.dismiss, dismissesShownOnly: originals.can });
after(() => {
  restore();
  S().updateSettings({ cliControl: false });
});

const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};

test("wake checks the request is still serving right before it reloads", async () => {
  const { windowId } = await freshWindow();
  const tabId = S().newTab(windowId, { url: "https://wake.example/", background: true });
  useLifecycle.setState((l) => ({ discarded: { ...l.discarded, [tabId]: true } }));
  let attached;
  let reloads = 0;
  webviews.set(tabId, { isAttached: () => new Promise((resolve) => (attached = resolve)), reload: () => (reloads++, Promise.resolve()) });
  try {
    const client = socketClient(241);
    void client.fire("apply", { ops: [{ op: "tab.wake", tabs: [tabId] }] }).catch(() => null);
    for (let i = 0; i < 50 && !attached; i++) await tick();
    assert.ok(attached, "it was waiting on isAttached");
    stub.emitControlClose(241);
    attached(true);
    await settle();
    assert.equal(reloads, 0, "no reload after the client left");
  } finally {
    webviews.delete(tabId);
    useLifecycle.setState({ discarded: {} });
  }
});

async function windowThatAsks() {
  const { windowId } = await freshWindow();
  S().createWindow({ url: "https://other.example/" });
  S().newTab(windowId, { url: "https://b.example/", background: true });
  S().newTab(windowId, { url: "https://c.example/", background: true });
  S().updateSettings({ warnBeforeClosingWindow: true });
  return windowId;
}

async function leaveWhileAsking(windowId, a, waiting) {
  void a.fire("windows.close", { window: windowId }).catch(() => null);
  for (let i = 0; i < 50 && !waiting.length; i++) await tick();
  stub.emitControlClose(a.connection);
  await settle();
}

test("a dismissal the bridge rejects counts as unsupported: the guard holds until the dialog is answered", async () => {
  const windowId = await windowThatAsks();
  const waiting = [];
  dialogs.confirm = () => new Promise((resolve) => waiting.push(resolve));
  dialogs.dismissesShownOnly = true;
  dialogs.dismissShownOnly = () => Promise.reject(new Error("no such method on this host"));
  try {
    const a = Object.assign(socketClient(251), { connection: 251 });
    await leaveWhileAsking(windowId, a, waiting);
    const held = await socketClient(252).call("windows.close", { window: windowId });
    assert.match(held.error?.message ?? "", /already closing or asking/);
    waiting[0]({ confirmed: false, suppressed: false });
    await settle();
    const again = socketClient(252).fire("windows.close", { window: windowId });
    for (let i = 0; i < 50 && waiting.length < 2; i++) await tick();
    assert.equal(waiting.length, 2, "freed once the dialog was answered");
    waiting[1]({ confirmed: false, suppressed: false });
    await again;
  } finally {
    restore();
  }
});

test("a bridge that answers every method doesn't count as dismissal support: only the capability flag does", async () => {
  const windowId = await windowThatAsks();
  const waiting = [];
  const calls = [];
  dialogs.confirm = () => new Promise((resolve) => waiting.push(resolve));
  dialogs.dismissesShownOnly = undefined;
  dialogs.dismissShownOnly = (...args) => (calls.push(args), Promise.resolve());
  try {
    const a = Object.assign(socketClient(261), { connection: 261 });
    await leaveWhileAsking(windowId, a, waiting);
    assert.deepEqual(calls, [], "no keyed call to a build that doesn't say it takes one");
    const held = await socketClient(262).call("windows.close", { window: windowId });
    assert.match(held.error?.message ?? "", /already closing or asking/);
    waiting[0]({ confirmed: false, suppressed: false });
    await settle();
  } finally {
    restore();
  }
});
