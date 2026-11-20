import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const local = await import("./localStore.ts");
const { installErrorReporting } = await import("./errors.ts");
const { takeLiveWorkCounts } = await import("./workCounts.ts");
const { reportExtensionsLoaded } = await import("../extensions/loadHealth.ts");
const { refreshActionStates } = await import("../extensions/actionStates.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePages } = await import("../tabs/pageState.ts");
const { useExtensions } = await import("../extensions/store.ts");

const printed = [];
console.warn = (...args) => printed.push(["warn", ...args]);
console.error = (...args) => printed.push(["error", ...args]);
installErrorReporting();
client.loadChoice();
after(() => client.setSharing(false, "settings"));

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};
const queuedLogs = async () => {
  await client.saveQueueNow();
  return (JSON.parse(stub.docs.get("telemetry-queue.json") ?? "{}").logs ?? []).map((log) => log.body?.stringValue ?? log.body);
};
const localLogs = (message) => {
  local.flushLocal();
  return stub.telemetryLocal.records().filter((r) => r.kind === "log" && r.message === message);
};

test("a warning from work that began while sharing was off stays on this Mac once sharing is on", async () => {
  client.setSharing(false, "settings");
  reportExtensionsLoaded("continuation-profile");
  client.setSharing(true, "settings");
  await settle();
  assert.ok(printed.some(([level, message]) => level === "warn" && message === "[extensions] load health failed"));
  assert.deepEqual((await queuedLogs()).filter((m) => m === "[extensions] load health failed"), []);
  assert.deepEqual(localLogs("[extensions] load health failed").map((r) => r.sent), [false]);
});

test("an extension action-state request that began while sharing was off isn't counted in the next period", async () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  const windowId = S().createWindow({ url: "a.com" });
  const tabId = S().windows[windowId].tabIds[0];
  useExtensions.setState({ lists: { "": [{ id: "one", name: "One", enabled: true, pinned: true, hasAction: true, incognito: false }] }, actions: {}, popup: null });
  usePages.setState({ ready: { [tabId]: 1 } });
  let reject;
  stub.extensionAnswers.actionStates = () => new Promise((_, no) => (reject = no));
  client.setSharing(false, "settings");
  const refreshed = refreshActionStates();
  await settle();
  client.setSharing(true, "settings");
  takeLiveWorkCounts();
  reject(new Error("engine gone"));
  await refreshed;
  assert.equal(takeLiveWorkCounts().extension_action_state_failures, 0);
  local.flushLocal();
  assert.ok(stub.telemetryLocal.records().some((r) => r.event === "usage_counts" && r.sent === false && r.properties?.extension_action_state_failures === 1));
});
