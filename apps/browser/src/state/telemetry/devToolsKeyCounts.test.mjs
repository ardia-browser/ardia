import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
const { takeDevToolsKeyCounts } = await import("./devToolsKeyCounts.ts");
after(() => client.setSharing(false, "settings"));

test("each ⇧⌘C a focused Developer Tools keeps is counted for the hour, then the count starts again", () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takeDevToolsKeyCounts();
  stub.emitEvent("engine.devToolsKeyKept", { epoch: client.consentEpoch() });
  stub.emitEvent("engine.devToolsKeyKept", { epoch: client.consentEpoch() });
  assert.deepEqual(takeDevToolsKeyCounts(), { devtools_keys_kept: 2 });
  assert.deepEqual(takeDevToolsKeyCounts(), { devtools_keys_kept: 0 });
});

test("a kept ⇧⌘C from while sharing was off, from an earlier consent period or with no epoch isn't counted and isn't kept in the local copy", async () => {
  client.setSharing(true, "onboarding");
  const earlier = client.consentEpoch();
  client.setSharing(false, "settings");
  stub.emitEvent("engine.devToolsKeyKept", { epoch: "" });
  client.setSharing(true, "settings");
  takeDevToolsKeyCounts();
  stub.emitEvent("engine.devToolsKeyKept", { epoch: earlier });
  stub.emitEvent("engine.devToolsKeyKept", {});
  assert.deepEqual(takeDevToolsKeyCounts(), { devtools_keys_kept: 0 });
  const { flushLocal } = await import("./localStore.ts");
  await flushLocal();
  assert.deepEqual(stub.telemetryLocal.records().filter((r) => r.event === "usage_counts" && r.properties.devtools_keys_kept), []);
});
