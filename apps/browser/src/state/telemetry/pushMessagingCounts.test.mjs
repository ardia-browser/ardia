import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const client = await import("./client.ts");
after(() => client.setSharing(false, "settings"));
const { notePushMessaging, takePushMessagingCounts } = await import("./pushMessagingCounts.ts");

const totals = (subscribed, subscribeFailed, subscribeRefusedOff, delivered) => ({ subscribed, subscribeFailed, subscribeRefusedOff, delivered });
const counts = (subscribes, failures, refused, delivered) => ({ push_subscribes: subscribes, push_subscribe_failures: failures, push_subscribes_refused_off: refused, push_messages_delivered: delivered });

test("the engine's running push totals become the increase since the last reading, and reset when taken", () => {
  client.setSharing(true, "onboarding");
  notePushMessaging(totals(0, 0, 0, 0));
  takePushMessagingCounts();
  notePushMessaging(totals(1, 0, 2, 3));
  assert.deepEqual(takePushMessagingCounts(), counts(1, 0, 2, 3));
  notePushMessaging(totals(1, 0, 2, 3));
  assert.deepEqual(takePushMessagingCounts(), counts(0, 0, 0, 0));
  notePushMessaging(totals(2, 1, 2, 5));
  notePushMessaging(undefined);
  assert.deepEqual(takePushMessagingCounts(), counts(1, 1, 0, 2));
});

test("totals reached while sharing was off are never counted once it is on again", () => {
  client.setSharing(true, "onboarding");
  notePushMessaging(totals(2, 1, 2, 5));
  takePushMessagingCounts();
  client.setSharing(false, "settings");
  client.setSharing(true, "onboarding");
  notePushMessaging(totals(4, 1, 6, 9));
  assert.deepEqual(takePushMessagingCounts(), counts(0, 0, 0, 0));
  notePushMessaging(totals(5, 1, 6, 10));
  assert.deepEqual(takePushMessagingCounts(), counts(1, 0, 0, 1));
});
