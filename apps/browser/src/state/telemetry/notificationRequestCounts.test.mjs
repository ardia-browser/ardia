import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const client = await import("./client.ts");
after(() => client.setSharing(false, "settings"));
const { noteEngineNotificationResponse, noteWebNotificationClicked, takeNotificationRequestCounts } = await import("./notificationRequestCounts.ts");

test("notification clicks and service worker notification responses are counted and reset when taken", () => {
  client.setSharing(true, "onboarding");
  takeNotificationRequestCounts();
  noteWebNotificationClicked();
  noteWebNotificationClicked();
  noteEngineNotificationResponse();
  assert.deepEqual(takeNotificationRequestCounts(), { notification_requests_auto_denied: 0, web_notification_clicks: 2, worker_notification_responses: 1 });
  assert.deepEqual(takeNotificationRequestCounts(), { notification_requests_auto_denied: 0, web_notification_clicks: 0, worker_notification_responses: 0 });
});
