import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const posted = [];
let outcome = () => Promise.resolve({ id: "ok", icon: "none" });
globalThis.acTestNativeModules = {
  ArdiaNotifications: {
    notificationPermission: () => Promise.resolve("granted"),
    requestNotificationPermission: () => Promise.resolve(true),
    removeNotifications: () => Promise.resolve(),
    openNotificationSettings: () => Promise.resolve(),
    addListener: () => ({ remove() {} }),
    postNotification: (options) => (posted.push(options), outcome(options)),
  },
};
const stub = await import("../../test-native/index.ts");
stub.docs.set("telemetry.json", JSON.stringify({ version: 99, sharing: true, installId: "notify", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: null, sessionOpen: false }));
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
client.loadChoice();
const { WEB_NOTIFICATION_FAILED, recordWebNotificationPost, webNotificationFailureProperties } = await import("./webNotificationFailures.ts");
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { showWebNotification } = await import("../site/webNotifications.ts");
const { takeFocusFeatureCounts } = await import("./focusFeatureCounts.ts");

const S = () => useBrowser.getState();
const SENT = { titleLength: 12, bodyLength: 40, iconRequested: true, iconSent: false };
const TEXT = { title: "Alice sent you a secret", body: "the launch code is 0000" };

async function failures() {
  await client.saveQueueNow();
  return JSON.parse(stub.docs.get("telemetry-queue.json") ?? "{}").events?.filter((e) => e.event === WEB_NOTIFICATION_FAILED) ?? [];
}

async function untilPosted(base) {
  for (let i = 0; i < 200 && posted.length < base + 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(posted.length, base + 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("a refused post is described by lengths, flags and macOS's own error code", () => {
  assert.deepEqual(
    webNotificationFailureProperties(SENT, { icon: "attachment_rejected", iconErrorCode: 2, errorDomain: "UNErrorDomain", errorCode: 1 }),
    {
      title_length: 12,
      body_length: 40,
      icon_requested: true,
      icon_sent: false,
      icon_status: "attachment_rejected",
      via_shim: true,
      threw: false,
      error_code: 1,
      error_domain: "UNErrorDomain",
      icon_error_code: 2,
    },
  );
});

test("a thrown post carries the error's type and an unknown icon status", () => {
  const props = webNotificationFailureProperties(SENT, null, { error: new TypeError("nope") });
  assert.equal(props.threw, true);
  assert.equal(props.error_type, "TypeError");
  assert.equal(props.icon_status, "unknown");
  assert.equal("error_code" in props, false);
});

test("a post macOS accepted records nothing", async () => {
  await recordWebNotificationPost(Promise.resolve({ id: "web:1", icon: "attached" }), SENT);
  assert.equal((await failures()).length, 0);
});

test("a post a Windows or Linux host accepted answers with the id as text and records nothing", async () => {
  const before = (await failures()).length;
  await recordWebNotificationPost(Promise.resolve("web:2"), SENT);
  await recordWebNotificationPost(Promise.resolve(null), SENT);
  assert.equal((await failures()).length, before);
});

test("a post with no id records one event with the error code", async () => {
  await recordWebNotificationPost(Promise.resolve({ icon: "download_failed", iconErrorCode: -1009, errorDomain: "UNErrorDomain", errorCode: 3 }), SENT);
  const events = await failures();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].properties.error_code, 3);
  assert.equal(events[0].properties.error_domain, "UNErrorDomain");
  assert.equal(events[0].properties.icon_status, "download_failed");
  assert.equal(events[0].properties.icon_error_code, -1009);
  assert.equal(events[0].properties.via_shim, true);
});

test("a rejected post records one event and the rejection still reaches the caller", async () => {
  const before = (await failures()).length;
  const error = new RangeError("native gone");
  await assert.rejects(recordWebNotificationPost(Promise.reject(error), SENT), (thrown) => thrown === error);
  const events = await failures();
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1).properties.threw, true);
  assert.equal(events.at(-1).properties.error_type, "RangeError");
});

function pendingPost() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => ((resolve = ok), (reject = fail)));
  return { promise, resolve, reject };
}

const REFUSED = { icon: "download_failed", iconErrorCode: -1009, errorDomain: "UNErrorDomain", errorCode: 3 };

test("a post that started while sharing was off and fails after it is turned on sends nothing", async () => {
  client.setSharing(false, "settings");
  const refused = pendingPost();
  const thrown = pendingPost();
  const recorded = recordWebNotificationPost(refused.promise, SENT);
  const rejected = recordWebNotificationPost(thrown.promise, SENT);
  client.setSharing(true, "settings");
  const before = (await failures()).length;
  refused.resolve(REFUSED);
  const error = new TypeError("posting failed");
  thrown.reject(error);
  await recorded;
  await assert.rejects(rejected, (caught) => caught === error);
  assert.equal((await failures()).length, before);
});

test("a post pending while sharing went off and back on sends nothing", async () => {
  client.setSharing(true, "settings");
  const refused = pendingPost();
  const thrown = pendingPost();
  const recorded = recordWebNotificationPost(refused.promise, SENT);
  const rejected = recordWebNotificationPost(thrown.promise, SENT);
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  const before = (await failures()).length;
  refused.resolve(REFUSED);
  const error = new TypeError("posting failed");
  thrown.reject(error);
  await recorded;
  await assert.rejects(rejected, (caught) => caught === error);
  assert.equal((await failures()).length, before);
});

test("a post that starts and fails with sharing on throughout still sends, and its rejection still reaches the caller", async () => {
  client.setSharing(true, "settings");
  const before = (await failures()).length;
  const refused = pendingPost();
  const thrown = pendingPost();
  const recorded = recordWebNotificationPost(refused.promise, SENT);
  const rejected = recordWebNotificationPost(thrown.promise, SENT);
  refused.resolve(REFUSED);
  const error = new TypeError("posting failed");
  thrown.reject(error);
  await recorded;
  await assert.rejects(rejected, (caught) => caught === error);
  const sent = (await failures()).slice(before);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].properties.error_code, 3);
  assert.equal(sent[1].properties.threw, true);
});

test("a website notification macOS refuses writes one record with lengths and no text", async () => {
  const before = (await failures()).length;
  const base = posted.length;
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://chat.example/" });
  const tabId = model.activeTabId(S(), windowId);
  outcome = () => Promise.resolve({ icon: "none", errorDomain: "UNErrorDomain", errorCode: 1 });
  showWebNotification(tabId, { id: "n1", ...TEXT, icon: null, tag: "", silent: false, requireInteraction: false, origin: "https://chat.example", tabId, isMainFrame: true });
  await untilPosted(base);
  const events = (await failures()).slice(before);
  assert.equal(events.length, 1);
  const { properties } = events[0];
  assert.equal(properties.title_length, TEXT.title.length);
  assert.equal(properties.body_length, TEXT.body.length);
  assert.equal(properties.icon_requested, false);
  assert.equal(properties.icon_sent, false);
  assert.equal(properties.error_code, 1);
  assert.equal(properties.via_shim, true);
  const sent = JSON.stringify(stub.docs.get("telemetry-queue.json"));
  assert.ok(!sent.includes(TEXT.title) && !sent.includes(TEXT.body));
});

test("a website notification macOS accepts writes no failure record", async () => {
  const before = (await failures()).length;
  const base = posted.length;
  const windowId = S().createWindow({ url: "https://other.example/" });
  const tabId = model.activeTabId(S(), windowId);
  outcome = (options) => Promise.resolve({ id: options.id, icon: "none" });
  showWebNotification(tabId, { id: "n2", ...TEXT, icon: null, tag: "", silent: false, requireInteraction: false, origin: "https://other.example", tabId, isMainFrame: true });
  await untilPosted(base);
  assert.equal((await failures()).length, before);
});

test("every website notification that reached the page script is counted once, then the count resets", async () => {
  takeFocusFeatureCounts();
  const base = posted.length;
  const windowId = S().createWindow({ url: "https://count.example/" });
  const tabId = model.activeTabId(S(), windowId);
  outcome = (options) => Promise.resolve({ id: options.id, icon: "none" });
  showWebNotification(tabId, { id: "n3", ...TEXT, icon: null, tag: "", silent: false, requireInteraction: false, origin: "https://count.example", tabId, isMainFrame: true });
  await untilPosted(base);
  assert.equal(takeFocusFeatureCounts().web_notifications_from_shim, 1);
  assert.equal(takeFocusFeatureCounts().web_notifications_from_shim, 0);
});
