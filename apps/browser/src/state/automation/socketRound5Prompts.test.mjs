import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow, controlOn, tick } = await import("./fixtures/socketHarness.mjs");
const { runMethod } = await import("./controlSocket.ts");
const { useBrowser } = await import("../browser/store.ts");
const { AUTOMATION } = await import("./automationCommands.ts");
const { COMMANDS } = await import("../commands/commandCatalog.ts");
const { COMMAND_INTERACTION } = await import("../commands/commandInteraction.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const dialogs = shellNativeModules.ArdiaDialogs;
const originals = { confirm: dialogs.confirm, dismiss: dialogs.dismissShownOnly, can: dialogs.dismissesShownOnly };
const restore = () => Object.assign(dialogs, { confirm: originals.confirm, dismissShownOnly: originals.dismiss, dismissesShownOnly: originals.can });
after(() => {
  restore();
  delete globalThis.acTestUserScripts;
  S().updateSettings({ cliControl: false });
});

const { fire, call } = socketClient(111);
const other = socketClient(112);

test("profiles.delete opens no question once control went off while it was still reading", async () => {
  await freshWindow();
  S().createProfile({ name: "Work" });
  let listed;
  globalThis.acTestUserScripts = { engine: { list: () => new Promise((resolve) => (listed = resolve)), install: async () => "x", reload: async () => {}, uninstall: async () => {} } };
  const asked = [];
  dialogs.confirm = (options) => (asked.push(options), Promise.resolve({ confirmed: true, suppressed: false }));
  try {
    const deleting = fire("profiles.delete", { profile: S().settings.defaultProfileId });
    for (let i = 0; i < 50 && !listed; i++) await tick();
    assert.ok(listed, "it was still listing extensions");
    S().updateSettings({ cliControl: false });
    listed([]);
    const reply = await deleting;
    assert.equal(asked.length, 0, "no question opened after control went off");
    assert.ok(reply.error);
  } finally {
    restore();
    delete globalThis.acTestUserScripts;
  }
});

test("without native dismissal the close guard holds until the question is answered, and a late yes does nothing", async () => {
  const { windowId } = await freshWindow();
  S().createWindow({ url: "https://other.example/" });
  S().newTab(windowId, { url: "https://b.example/", background: true });
  S().newTab(windowId, { url: "https://c.example/", background: true });
  S().updateSettings({ warnBeforeClosingWindow: true });
  const waiting = [];
  dialogs.confirm = () => new Promise((resolve) => waiting.push(resolve));
  dialogs.dismissesShownOnly = false;
  try {
    const closing = fire("windows.close", { window: windowId });
    for (let i = 0; i < 50 && !waiting.length; i++) await tick();
    S().updateSettings({ cliControl: false });
    for (let i = 0; i < 10; i++) await tick();
    await controlOn();
    const again = await other.call("windows.close", { window: windowId });
    assert.equal(again.error?.code, "refused");
    assert.match(again.error.message, /already closing or asking/, "the guard holds while the question is still up");
    waiting[0]({ confirmed: true, suppressed: false });
    await closing;
    assert.ok(S().windows[windowId], "a yes after control went off closes nothing");
  } finally {
    restore();
  }
});

test("every registered command is classified, and background run allows only the ones that open nothing", async () => {
  const missing = Object.keys(COMMANDS).filter((id) => !Object.hasOwn(COMMAND_INTERACTION, id));
  assert.deepEqual(missing, [], "every command in the registry has a classification");
  assert.deepEqual(Object.keys(AUTOMATION).filter((id) => !Object.hasOwn(COMMAND_INTERACTION, id)), []);
  const { windowId } = await freshWindow();
  for (const command of ["print", "cast", "newProfile", "pinExtensions", "clearBrowsingData", "bookmarkPage", "openProfileMenu"]) {
    assert.equal(runMethod({ command, window: windowId }, true).error?.code, "refused", command);
  }
  assert.equal(runMethod({ command: "toggleSidebar", window: windowId }, true).error?.code, "refused", "no command runs in the background");
});

test("a close refused because nobody could see the question still drops a stale last-window marker", async () => {
  const { windowId } = await freshWindow();
  S().createWindow({ url: "https://other.example/" });
  S().newTab(windowId, { url: "https://b.example/", background: true });
  S().newTab(windowId, { url: "https://c.example/", background: true });
  S().updateSettings({ warnBeforeClosingWindow: true });
  S().closeWindow(S().createWindow({ url: "https://gone.example/" }));
  useBrowser.setState((s) => ({ closedWindows: s.closedWindows.map((c, i, all) => (i === all.length - 1 ? { ...c, lastWindow: true } : c)) }));
  assert.equal(S().closedWindows.filter((c) => c.lastWindow).length, 1, "a stale marker while windows are open");
  dialogs.confirm = (options) => Promise.resolve(options.onlyIfShown ? { confirmed: false, suppressed: false, unshown: true } : { confirmed: true, suppressed: false });
  try {
    const reply = await call("windows.close", { window: windowId });
    assert.equal(reply.error?.code, "refused");
    assert.equal(S().closedWindows.filter((c) => c.lastWindow).length, 0);
  } finally {
    restore();
  }
});
