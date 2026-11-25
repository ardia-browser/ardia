import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
globalThis.fetch = async () => ({ status: 503 });

const client = await import("../telemetry/client.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startActionStates, watchActionsOf } = await import("./actionWatch.ts");
const { extensionWorld } = await import("../automation/fixtures/extensionWorld.mjs");

const printed = [];
console.warn = (...args) => printed.push(args[0]);
client.loadChoice();
after(() => client.setSharing(false, "settings"));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const queuedLogs = async () => {
  await client.saveQueueNow();
  return (JSON.parse(stub.docs.get("telemetry-queue.json") ?? "{}").logs ?? []).map((log) => log.body?.stringValue ?? log.body);
};

test("a registry change that arrived while sharing was off logs nothing at its flush, even once sharing is on", async () => {
  useBrowser.getState().hydrate({});
  useBrowser.getState().createWindow({ url: "https://a.example/" });
  const { gates } = extensionWorld();
  startActionStates();
  watchActionsOf("");
  gates.listFails = true;
  client.setSharing(false, "settings");
  stub.emitEvent("extensions.action", { profile: "", id: "x", kind: "registry" });
  client.setSharing(true, "settings");
  await wait(400);
  assert.deepEqual(printed.filter((m) => m === "[extensions] list failed"), []);
  assert.deepEqual((await queuedLogs()).filter((m) => m === "[extensions] list failed"), []);

  stub.emitEvent("extensions.action", { profile: "", id: "x", kind: "registry" });
  await wait(400);
  assert.equal(printed.filter((m) => m === "[extensions] list failed").length, 1, "a change that arrives while sharing is on still logs its failure");
  gates.listFails = false;
});
