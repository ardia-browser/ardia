import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(callback, 0);
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
const usage = await import("./usage.ts");
const local = await import("./localStore.ts");
const { telemetryLocal } = await import("../../test-native/telemetryLocal.ts");
const { useBrowser } = await import("../browser/store.ts");
const S = () => useBrowser.getState();
after(() => client.setSharing(false, "settings"));

const reaches = () => {
  usage.emitWindowUsage(client.consentNow());
  local.flushLocal();
  return telemetryLocal.records().filter((r) => r.event === "usage_counts").reduce((sum, r) => sum + (r.properties.split_four_pane_reaches ?? 0), 0);
};

const grow = () => {
  const windowId = S().createWindow({ url: "https://one.example/" });
  const anchorTabId = S().windows[windowId].tabIds[0];
  for (let i = 0; i < 2; i++) assert.equal(S().openSplitPane(windowId, { anchorTabId, side: "right" }).ok, true);
  return { windowId, anchorTabId };
};

test("four-pane reaches count growth once, ignore resizing, and stay within consent periods", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  client.loadChoice();
  usage.startUsage();
  client.setSharing(true, "settings");
  const { windowId, anchorTabId } = grow();
  assert.equal(reaches(), 0);
  const fourth = S().openSplitPane(windowId, { anchorTabId, side: "right" });
  assert.equal(fourth.ok, true);
  assert.equal(reaches(), 1);
  const splitId = fourth.splitId;
  S().updateSplit(splitId, { sizes: [0.1, 0.2, 0.3, 0.4] });
  assert.deepEqual(S().splits[splitId].slots.map((slot) => slot.size), [0.1, 0.2, 0.3, 0.4]);
  S().flipSplit(splitId);
  assert.deepEqual(S().splits[splitId].slots.map((slot) => slot.size), [0.4, 0.3, 0.2, 0.1]);
  assert.equal(reaches(), 1);
  S().removeTabFromSplit(fourth.tabId);
  assert.equal(S().openSplitPane(windowId, { anchorTabId, side: "right" }).ok, true);
  assert.equal(reaches(), 2);
  const pending = grow();
  assert.equal(S().openSplitPane(pending.windowId, { anchorTabId: pending.anchorTabId, side: "right" }).ok, true);
  client.setSharing(false, "settings");
  local.flushLocal();
  telemetryLocal.reset();
  const off = grow();
  const offFourth = S().openSplitPane(off.windowId, { anchorTabId: off.anchorTabId, side: "right" });
  assert.equal(offFourth.ok, true);
  assert.equal(reaches(), 0);
  client.setSharing(true, "settings");
  assert.equal(reaches(), 0);
  const before = S().splits[offFourth.splitId].slots;
  S().flipSplit(offFourth.splitId);
  assert.deepEqual(S().splits[offFourth.splitId].slots, [...before].reverse());
  assert.equal(reaches(), 0);
  const on = grow();
  assert.equal(S().openSplitPane(on.windowId, { anchorTabId: on.anchorTabId, side: "right" }).ok, true);
  assert.equal(reaches(), 1);
});
