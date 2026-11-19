import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../browser/src/test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", osVersion: "6.8", arch: "x64", isolatedInstance: false });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, decidedAt: 1, askDoneAt: 1, installId: "install", crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false, lastQuitAt: 1000 }));
stub.docs.delete("telemetry-queue.json");
globalThis.fetch = async () => ({ status: 200 });

const { startClient } = await import("../../browser/src/state/telemetry/client.ts");
const { handleTelemetryOp } = await import("./telemetryOps.ts");
startClient();

const sessionOpen = () => JSON.parse(stub.docs.get("telemetry.json")).sessionOpen;
const sessionEnds = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event === "app_session_ended").length;

test("a quit Linux cancels takes its ended event back and reopens the saved session", async () => {
  const token = await handleTelemetryOp("end");
  assert.equal(sessionOpen(), false);
  assert.equal(sessionEnds(), 1);
  assert.equal(await handleTelemetryOp("reopen", token), true);
  assert.equal(sessionOpen(), true);
  assert.equal(sessionEnds(), 0);
});

test("two cancelled quits and a final one leave exactly one ended event", async () => {
  for (let cancel = 0; cancel < 2; cancel++) {
    const token = await handleTelemetryOp("end");
    assert.equal(sessionOpen(), false);
    assert.equal(await handleTelemetryOp("reopen", token), true);
    assert.equal(sessionOpen(), true, "the saved session is open between quits");
    assert.equal(sessionEnds(), 0);
  }
  await handleTelemetryOp("end");
  assert.equal(sessionOpen(), false);
  assert.equal(sessionEnds(), 1);
});
