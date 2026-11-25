import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../browser/src/test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../../browser/src/state/telemetry/client.ts");
const { watchSyncToggles } = await import("../../browser/src/state/telemetry/syncToggles.ts");
const { loadSyncCore, whenSyncCore } = await import("./hostSync.ts");
client.loadChoice();
after(() => client.setSharing(false, "settings"));

const tick = () => new Promise(setImmediate);

function statusStore(status) {
  const listeners = new Set();
  return {
    getState: () => ({ status }),
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    set(next) {
      status = next;
      for (const listener of listeners) listener({ status });
    },
  };
}

function pendingCore() {
  let answer = null;
  const host = {
    bootstrap: { windowId: "w1", profileId: "default", capabilities: ["ArdiaSync.core"] },
    call: async () => "{}",
    invoke: (method) => (method === "ArdiaSync.core" ? new Promise((resolve, reject) => (answer = { resolve, reject })) : Promise.resolve(null)),
    onEvent: () => () => {},
  };
  return { host, answer: () => answer };
}

async function queuedToggles() {
  await client.saveQueueNow();
  const events = JSON.parse(stub.docs.get("telemetry-queue.json") ?? "{}").events ?? [];
  return events.filter((event) => event.event === "sync_toggled").map(({ properties }) => (properties.on ? { on: true, sync_core: properties.sync_core } : { on: false }));
}

function watch(store) {
  return watchSyncToggles(store, whenSyncCore, client.consentToken, (toggle, consent) => client.capture("sync_toggled", toggle, consent));
}

test("sync turned on and off while ArdiaSync.core is pending reaches the send queue in order, the on carrying the engine's answer", async () => {
  client.setSharing(true, "settings");
  const store = statusStore("off");
  const stop = watch(store);
  const { host, answer } = pendingCore();
  const loading = loadSyncCore(host);
  await tick();
  store.set("updating");
  store.set("off");
  assert.deepEqual(await queuedToggles(), [], "neither toggle is sent before the engine answers, so the off can't overtake the on");
  answer().resolve("rust");
  await loading;
  await tick();
  assert.deepEqual(await queuedToggles(), [{ on: true, sync_core: "rust" }, { on: false }]);
  store.set("starting");
  assert.deepEqual((await queuedToggles()).at(-1), { on: true, sync_core: "rust" }, "once the engine has answered, a toggle is sent at once");
  stop();
});

test("toggles queued behind a pending ArdiaSync.core never reach the send queue when sharing ends before the answer", async () => {
  client.setSharing(true, "settings");
  const store = statusStore("off");
  const stop = watch(store);
  const { host, answer } = pendingCore();
  const loading = loadSyncCore(host);
  await tick();
  store.set("starting");
  store.set("off");
  client.setSharing(false, "settings");
  answer().resolve("rust");
  await loading;
  await tick();
  client.setSharing(true, "settings");
  assert.deepEqual(await queuedToggles(), [], "captured under the token taken at each toggle, which sharing-off ended");
  stop();
});

test("an engine that fails ArdiaSync.core sends its queued toggles as native, still in order", async () => {
  client.setSharing(true, "settings");
  const store = statusStore("off");
  const stop = watch(store);
  const { host, answer } = pendingCore();
  const loading = loadSyncCore(host);
  await tick();
  store.set("updating");
  store.set("off");
  answer().reject(new Error("ERR_UNKNOWN_CALL"));
  assert.equal(await loading, "native");
  await tick();
  assert.deepEqual(await queuedToggles(), [{ on: true, sync_core: "native" }, { on: false }]);
  stop();
});
