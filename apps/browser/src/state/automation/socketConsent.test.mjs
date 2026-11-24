import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow, controlOn, tick } = await import("./fixtures/socketHarness.mjs");
const { useBrowser } = await import("../browser/store.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const dialogs = shellNativeModules.ArdiaDialogs;
const system = shellNativeModules.ArdiaSystem;
const original = { confirm: dialogs.confirm, openFile: system.openFile, revealFile: system.revealFile };
after(() => {
  Object.assign(dialogs, { confirm: original.confirm });
  Object.assign(system, { openFile: original.openFile, revealFile: original.revealFile });
  S().updateSettings({ cliControl: false });
});

const { fire } = socketClient(61);

function holdConfirm() {
  const waiting = [];
  dialogs.confirm = () => new Promise((resolve) => waiting.push(resolve));
  return async (answer) => {
    for (let i = 0; i < 50 && !waiting.length; i++) await tick();
    assert.equal(waiting.length, 1, "Ardia asked");
    S().updateSettings({ cliControl: false });
    waiting[0](answer);
  };
}

test("profiles.delete confirmed after control went off deletes nothing", async () => {
  await freshWindow();
  const work = S().createProfile({ name: "Work" });
  const answer = holdConfirm();
  const deleting = fire("profiles.delete", { profile: work });
  await answer({ confirmed: true, suppressed: false });
  assert.ok(["refused", "failed"].includes((await deleting).error?.code), "the client sees the stream end either way");
  assert.ok(S().profiles[work], "the profile is still there");
  dialogs.confirm = original.confirm;
});

test("a close confirmed after control went off neither closes nor saves Don't ask again", async () => {
  const { windowId } = await freshWindow();
  S().createWindow({ url: "https://other.example/" });
  S().newTab(windowId, { url: "https://b.example/", background: true });
  S().newTab(windowId, { url: "https://c.example/", background: true });
  S().updateSettings({ warnBeforeClosingWindow: true });
  dialogs.confirm = (options) => (options.onlyIfShown ? holding(options) : Promise.resolve({ confirmed: false, suppressed: false }));
  const waiting = [];
  const holding = () => new Promise((resolve) => waiting.push(resolve));
  const closing = fire("windows.close", { window: windowId });
  for (let i = 0; i < 50 && !waiting.length; i++) await tick();
  S().updateSettings({ cliControl: false });
  waiting[0]({ confirmed: true, suppressed: true });
  assert.ok(["refused", "failed"].includes((await closing).error?.code), "the client sees the stream end either way");
  assert.ok(S().windows[windowId]);
  assert.equal(S().settings.warnBeforeClosingWindow, true, "the preference wasn't written");
  dialogs.confirm = original.confirm;
});

test("history.clear leaves the history cache to the engine's own events once control is off", async () => {
  await freshWindow();
  const list = [{ url: "https://kept.example/", title: "Kept", favicon: null, visits: 1, lastVisit: 5 }];
  useBrowser.setState((s) => ({ history: { ...s.history, "": { list, floor: 0, ready: true } } }));
  const clearing = fire("history.clear", {});
  S().updateSettings({ cliControl: false });
  await clearing;
  assert.equal(S().history[""].list.length, 1, "the socket didn't write the cache after control went off");
  useBrowser.setState((s) => ({ history: Object.fromEntries(Object.entries(s.history).filter(([k]) => k !== "")) }));
});

test("downloads.open on an archive doesn't go on to reveal it once control is off", async () => {
  await freshWindow();
  S().upsertDownload({ id: "z1", url: "https://files.example/a.zip", filename: "a.zip", path: "/tmp/a.zip", state: "finished", paused: false, received: 1, total: 1, speed: 0, mimeType: "application/zip", profile: "" });
  const opened = [];
  const revealed = [];
  system.openFile = (path) => new Promise((resolve) => opened.push(() => resolve(true)));
  system.revealFile = (path) => (revealed.push(path), Promise.resolve(true));
  const opening = fire("downloads.open", { id: "z1" });
  for (let i = 0; i < 50 && !opened.length; i++) await tick();
  S().updateSettings({ cliControl: false });
  opened[0]();
  await opening;
  assert.deepEqual(revealed, [], "the archive's folder wasn't revealed");
  Object.assign(system, { openFile: original.openFile, revealFile: original.revealFile });
  await controlOn();
});
