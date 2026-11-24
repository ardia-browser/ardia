import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../browser/src/test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../../browser/src/state/telemetry/client.ts");
const { applyChoiceDurably } = await import("./telemetryChoiceApply.ts");
after(() => client.setSharing(false, "settings"));

test("the leader answers a follower's sharing-off with the verdict of its own verified save and retry, and never rejects over a save that the retry recovered", async () => {
  client.loadChoice();
  const documents = stub.shellNativeModules.ArdiaDocuments;
  const saved = documents.documentSaved;
  const offWith = async (failures) => {
    client.setSharing(true, "onboarding");
    documents.documentSaved = (...args) => (failures-- > 0 ? Promise.reject(new Error("save refused")) : saved(...args));
    try {
      return await applyChoiceDurably({ kind: "sharing", on: false, source: "settings" }).then((value) => ({ value }), (error) => ({ error: String(error) }));
    } finally {
      documents.documentSaved = saved;
    }
  };
  assert.deepEqual(await offWith(1), { value: true });
  assert.equal(JSON.parse(stub.docs.get("telemetry.json")).sharing, false);
  assert.deepEqual(await offWith(2), { value: false });
});

test("a follower window reports the leader's save verdict for its choice, and false when the request itself fails", async () => {
  const { followerChoiceSaved } = await import("./telemetryChoiceApply.ts");
  const refreshed = [];
  const refresh = async () => { refreshed.push(true); };
  const reported = [];
  assert.equal(await followerChoiceSaved(Promise.resolve(false), refresh, (error) => reported.push(error)), false);
  assert.equal(await followerChoiceSaved(Promise.resolve(true), refresh, (error) => reported.push(error)), true);
  assert.equal(await followerChoiceSaved(Promise.reject(new Error("no leader")), refresh, (error) => reported.push(error)), false);
  assert.equal(refreshed.length, 3);
  assert.deepEqual(reported.map(String), ["Error: no leader"]);
});

test("a follower's sharing change resolves with the leader's verdict after refreshing its view, so a failed save isn't reported as durable", async () => {
  const { followerChoiceSaved } = await import("./telemetryChoiceApply.ts");
  const refreshed = [];
  const refresh = async () => void refreshed.push(1);
  const reported = [];
  assert.equal(await followerChoiceSaved(Promise.resolve(false), refresh, (e) => reported.push(e)), false);
  assert.equal(await followerChoiceSaved(Promise.resolve(true), refresh, (e) => reported.push(e)), true);
  assert.equal(await followerChoiceSaved(Promise.reject(new Error("no leader")), refresh, (e) => reported.push(e)), false);
  assert.deepEqual([refreshed.length, reported.length], [3, 1]);
});
