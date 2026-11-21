import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { setTelemetryRelay } = await import("./relay.ts");
const { noteTopAppsSharing } = await import("./topAppsSharing.ts");

const relayed = [];
const relay = { capture: (event, props) => void relayed.push([event, props]), log: () => {}, resetId: async () => "id", change: () => {}, installId: () => "id" };

test("a window that relays to another window's telemetry (a Linux follower) sends what it held as soon as the relay is ready, and later events at once", () => {
  noteTopAppsSharing("top_apps_mirrored", { tiles: 1 });
  assert.deepEqual(relayed, [], "held until telemetry or a relay is ready");
  setTelemetryRelay(relay);
  assert.deepEqual(relayed.map(([event]) => event), ["top_apps_mirrored"], "the relay takes what was held");
  noteTopAppsSharing("top_apps_mirrored", { tiles: 2 });
  assert.equal(relayed.length, 2, "and every event after it");
  setTelemetryRelay(null);
});
