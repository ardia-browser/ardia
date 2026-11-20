import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { setTelemetryRelay } = await import("./relay.ts");
const { noteTopAppsSharing, releaseTopAppsSharing } = await import("./topAppsSharing.ts");

test("more events before telemetry starts than the buffer holds are counted, not lost without a trace", () => {
  const sent = [];
  for (let i = 0; i < 20; i++) noteTopAppsSharing("top_apps_sharing_synced", { path: "synced_record", on: true });
  setTelemetryRelay({ capture: (event, props) => void sent.push([event, props]), log: () => {}, resetId: async () => "id", change: () => {}, installId: () => "id" });
  releaseTopAppsSharing();
  assert.equal(sent.filter(([event]) => event === "top_apps_sharing_synced").length, 16);
  assert.deepEqual(sent.filter(([event]) => event === "top_apps_sharing_dropped").map(([, props]) => props), [{ dropped: 4 }]);
  setTelemetryRelay(null);
});
