import assert from "node:assert/strict";
import { after, test } from "node:test";
const { shellNativeModules } = await import("../../test-native/shell.ts");
shellNativeModules.ArdiaSystem.backgroundInstance = true;
const { S, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { backgroundInstance } = await import("../app/appSettings.ts");
const { runMethod } = await import("./controlSocket.ts");

after(() => S().updateSettings({ cliControl: false }));

test("a background instance refuses downloads.open, which launches another app", async () => {
  assert.equal(backgroundInstance, true, "this file runs as a background instance");
  const { windowId } = await freshWindow();
  S().upsertDownload({ id: "bg1", url: "https://files.example/a.pdf", filename: "a.pdf", path: "/tmp/a.pdf", state: "finished", paused: false, received: 1, total: 1, speed: 0, mimeType: "application/pdf", profile: "" });
  const opened = [];
  const system = shellNativeModules.ArdiaSystem;
  const { openFile, revealFile } = system;
  system.openFile = (path) => (opened.push(path), Promise.resolve(true));
  system.revealFile = () => Promise.resolve(true);
  try {
    const reply = await socketClient(231).call("downloads.open", { id: "bg1" });
    assert.equal(reply.error?.code, "refused");
    assert.match(reply.error.message, /opening a download needs the person/);
    assert.deepEqual(opened, []);
    const reveal = await socketClient(232).call("downloads.reveal", { id: "bg1" });
    assert.equal(reveal.error?.code, "refused", "a background instance only logs a reveal, so it can't claim one");
    assert.match(reveal.error.message, /revealing a download needs the person/);
  } finally {
    Object.assign(system, { openFile, revealFile });
  }
  assert.equal(runMethod({ command: "reopenClosedTab", window: windowId }).error?.code, "refused", "the default for run is this instance's own mode");
});
