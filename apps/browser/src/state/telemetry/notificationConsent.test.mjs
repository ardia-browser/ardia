import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { noteWebNotificationFromShim } = await import("./webNotificationCounts.ts");
const { noteWebNotificationClicked, noteEngineNotificationResponse } = await import("./notificationRequestCounts.ts");
after(() => client.setSharing(false, "settings"));

const noteAll = () => {
  noteWebNotificationFromShim();
  noteWebNotificationClicked();
  noteEngineNotificationResponse();
};

async function lastCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  const p = saved.events.filter((e) => e.event === "usage_counts").at(-1)?.properties ?? {};
  return { fromShim: p.web_notifications_from_shim ?? 0, clicks: p.web_notification_clicks ?? 0, workers: p.worker_notification_responses ?? 0 };
}

test("notifications counted while sharing is off never reach usage_counts once sharing is turned on", async () => {
  client.setSharing(false, "settings");
  noteAll();
  noteAll();
  client.setSharing(true, "onboarding");
  noteAll();
  usage.emitWindowUsage();
  assert.deepEqual(await lastCounts(), { fromShim: 1, clicks: 1, workers: 1 });
});

test("counts pending when sharing is turned off are dropped, not sent after it's turned on again", async () => {
  client.setSharing(true, "onboarding");
  noteAll();
  client.setSharing(false, "settings");
  client.setSharing(true, "onboarding");
  noteAll();
  noteAll();
  usage.emitWindowUsage();
  assert.deepEqual(await lastCounts(), { fromShim: 2, clicks: 2, workers: 2 });
});
