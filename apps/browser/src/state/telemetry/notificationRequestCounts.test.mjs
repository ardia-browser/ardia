import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));
const { noteEngineNotificationResponse, noteWebNotificationClicked, takeNotificationRequestCounts } = await import("./notificationRequestCounts.ts");

const ENGINE_COUNTS = { engine_notifications_to_engine_delegate: 0, engine_notifications_shown_by_hub: 0 };

const sentUsageCounts = async () => {
  await client.saveQueueNow();
  return JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event === "usage_counts");
};

test("notification clicks and service worker notification responses are counted and reset when taken", () => {
  client.setSharing(true, "onboarding");
  takeNotificationRequestCounts();
  noteWebNotificationClicked();
  noteWebNotificationClicked();
  noteEngineNotificationResponse();
  assert.deepEqual(takeNotificationRequestCounts(), { notification_requests_auto_denied: 0, web_notification_clicks: 2, worker_notification_responses: 1, ...ENGINE_COUNTS });
  assert.deepEqual(takeNotificationRequestCounts(), { notification_requests_auto_denied: 0, web_notification_clicks: 0, worker_notification_responses: 0, ...ENGINE_COUNTS });
});

test("Chrome's own notifications are counted as handed to Chrome's delegate or shown by the hub, and the count starts again from zero", () => {
  client.setSharing(true, "onboarding");
  takeNotificationRequestCounts();
  stub.emitAppEvent({ type: "engineNotificationPresented", handedToEngine: true, epoch: client.consentEpoch() });
  stub.emitAppEvent({ type: "engineNotificationPresented", handedToEngine: true, epoch: client.consentEpoch() });
  stub.emitAppEvent({ type: "engineNotificationPresented", handedToEngine: false, epoch: client.consentEpoch() });
  assert.deepEqual(takeNotificationRequestCounts(), {
    notification_requests_auto_denied: 0,
    web_notification_clicks: 0,
    worker_notification_responses: 0,
    engine_notifications_to_engine_delegate: 2,
    engine_notifications_shown_by_hub: 1,
  });
  assert.deepEqual(takeNotificationRequestCounts(), { notification_requests_auto_denied: 0, web_notification_clicks: 0, worker_notification_responses: 0, ...ENGINE_COUNTS });
});

test("an hour where Chrome posted notifications and nothing else happened sends usage_counts with how many went each way, and nothing from the notification", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takeNotificationRequestCounts();
  const before = (await sentUsageCounts()).length;

  stub.emitAppEvent({ type: "engineNotificationPresented", handedToEngine: true, title: "New mail from Ada", body: "Lunch?", notificationId: "gmail-123", origin: "https://mail.google.com", epoch: client.consentEpoch() });
  stub.emitAppEvent({ type: "engineNotificationPresented", handedToEngine: false, title: "New mail from Ada", body: "Lunch?", notificationId: "gmail-124", origin: "https://mail.google.com", epoch: client.consentEpoch() });
  stub.emitAppEvent({ type: "engineNotificationPresented", handedToEngine: false, epoch: client.consentEpoch() });
  usage.sessionEnding();

  const sent = await sentUsageCounts();
  assert.equal(sent.length, before + 1);
  const props = sent.at(-1).properties;
  assert.equal(props.engine_notifications_to_engine_delegate, 1);
  assert.equal(props.engine_notifications_shown_by_hub, 2);
  const text = JSON.stringify(sent.at(-1));
  for (const secret of ["Ada", "Lunch", "gmail-12", "mail.google.com"]) assert.ok(!text.includes(secret), `${secret} must not be recorded`);
});

test("the notification settings macOS reports are sent once, as enum names", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takeNotificationRequestCounts();

  stub.emitAppEvent({ type: "notificationSettings", authorization: "denied", alertSetting: "disabled", alertStyle: "none", epoch: client.consentEpoch() });
  usage.sessionEnding();
  const first = (await sentUsageCounts()).at(-1).properties;
  assert.deepEqual([first.notification_authorization, first.notification_alert_setting, first.notification_alert_style], ["denied", "disabled", "none"]);

  const withSettings = async () => (await sentUsageCounts()).filter((e) => e.properties.notification_authorization !== undefined).length;
  const sentBefore = await withSettings();
  usage.sessionEnding();
  assert.equal(await withSettings(), sentBefore, "the next hour does not repeat the settings");
});

test("a setting that is not one of macOS's names goes out as other, so no free text is recorded", () => {
  client.setSharing(true, "onboarding");
  takeNotificationRequestCounts();
  stub.emitAppEvent({ type: "notificationSettings", authorization: "someone@example.com", alertSetting: 7, alertStyle: "banner", epoch: client.consentEpoch() });
  const taken = takeNotificationRequestCounts();
  assert.deepEqual([taken.notification_authorization, taken.notification_alert_setting, taken.notification_alert_style], ["other", "other", "banner"]);
});

test("notifications and settings from a stale or empty consent period, or while sharing is off, are not counted", () => {
  client.setSharing(true, "onboarding");
  takeNotificationRequestCounts();
  const stale = client.consentEpoch();
  client.setSharing(false, "settings");
  stub.emitAppEvent({ type: "engineNotificationPresented", handedToEngine: true, epoch: stale });
  stub.emitAppEvent({ type: "engineNotificationPresented", handedToEngine: false, epoch: "" });
  stub.emitAppEvent({ type: "notificationSettings", authorization: "authorized", alertSetting: "enabled", alertStyle: "banner", epoch: stale });
  client.setSharing(true, "settings");
  assert.deepEqual(takeNotificationRequestCounts(), { notification_requests_auto_denied: 0, web_notification_clicks: 0, worker_notification_responses: 0, ...ENGINE_COUNTS });
});
