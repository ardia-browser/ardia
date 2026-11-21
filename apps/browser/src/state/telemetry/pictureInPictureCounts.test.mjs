import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const pipCounts = await import("./pictureInPictureCounts.ts");
after(() => client.setSharing(false, "settings"));

async function sentUsageCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events
    .filter((e) => e.event === "usage_counts")
    .map((e) => ({ chromium: e.properties.pip_back_to_tab, webkit: e.properties.pip_back_to_tab_webkit, fromOtherApp: e.properties.pip_back_to_tab_from_other_app }));
}

test("going back to a tab from its Picture in Picture window is counted per engine and from another app, sent on its own, then starts again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");

  pipCounts.notePictureInPictureBackToTab("webkit");
  pipCounts.notePictureInPictureBackToTab("webkit", true);
  pipCounts.notePictureInPictureBackToTab("chromium", true);
  usage.sessionEnding();
  assert.deepEqual(await sentUsageCounts(), [{ chromium: 1, webkit: 2, fromOtherApp: 2 }]);

  usage.sessionEnding();
  assert.equal((await sentUsageCounts()).length, 1);
});

test("click skips in a Picture in Picture window are counted back and ahead, sent with the usage counts, then start again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const skipsSent = async () => {
    await client.saveQueueNow();
    const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
    return saved.events.filter((e) => e.event === "usage_counts").map((e) => [e.properties.pip_click_skips_back, e.properties.pip_click_skips_ahead]);
  };
  const before = (await skipsSent()).length;

  pipCounts.notePictureInPictureClickSkip({ seconds: -10, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureClickSkip({ seconds: 10, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureClickSkip({ seconds: 10, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureClickSkip({ seconds: 10, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureClickSkip({ seconds: 0, epoch: client.consentEpoch() });
  usage.sessionEnding();
  const sent = await skipsSent();
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent.at(-1), [1, 3]);

  usage.sessionEnding();
  assert.equal((await skipsSent()).length, before + 1);
});

test("clicks on a tucked Picture in Picture window's arrow are counted, sent with the usage counts, then start again from zero, and a click from before sharing's last change isn't", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const unstashesSent = async () => {
    await client.saveQueueNow();
    const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
    return saved.events.filter((e) => e.event === "usage_counts" && e.properties.pip_handle_unstashes).map((e) => e.properties.pip_handle_unstashes);
  };
  const before = (await unstashesSent()).length;

  pipCounts.notePictureInPictureHandleUnstash({ epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureHandleUnstash({ epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureHandleUnstash({ epoch: "an epoch from before" });
  usage.sessionEnding();
  const sent = await unstashesSent();
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1), 2);

  usage.sessionEnding();
  assert.equal((await unstashesSent()).length, before + 1);
});

test("pinches on a Picture in Picture window and resizes that ended before Chromium caught up are counted, then start again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const sentCounts = async () => {
    await client.saveQueueNow();
    const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
    return saved.events
      .filter((e) => e.event === "usage_counts" && (e.properties.pip_pinches || e.properties.pip_stand_in_timeouts))
      .map((e) => [e.properties.pip_pinches, e.properties.pip_stand_in_timeouts]);
  };
  const before = (await sentCounts()).length;

  pipCounts.notePictureInPictureStandIn({ pinch: true, timedOut: false, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureStandIn({ pinch: true, timedOut: true, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureStandIn({ pinch: false, timedOut: true, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureStandIn({ pinch: true, timedOut: false, epoch: "an epoch from before" });
  usage.sessionEnding();
  const sent = await sentCounts();
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent.at(-1), [2, 2]);

  usage.sessionEnding();
  assert.equal((await sentCounts()).length, before + 1);
});

test("activations asked for by a press or a move on a Picture in Picture window, and the ones that didn't take, are counted, then start again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const sentCounts = async () => {
    await client.saveQueueNow();
    const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
    return saved.events
      .filter((e) => e.event === "usage_counts" && e.properties.pip_activations)
      .map((e) => [e.properties.pip_activations, e.properties.pip_activation_failures]);
  };
  const before = (await sentCounts()).length;

  pipCounts.notePictureInPictureActivated({ move: false, activated: true, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureActivated({ move: true, activated: true, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureActivated({ move: false, activated: false, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureActivated({ move: true, activated: true, epoch: "an epoch from before" });
  usage.sessionEnding();
  const sent = await sentCounts();
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent.at(-1), [3, 1]);

  usage.sessionEnding();
  assert.equal((await sentCounts()).length, before + 1);
});

test("activations Ardia handed back after it was left over a Picture in Picture window, and repeats, are counted, then start again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const sentCounts = async () => {
    await client.saveQueueNow();
    const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
    return saved.events
      .filter((e) => e.event === "usage_counts" && e.properties.pip_activation_hand_backs)
      .map((e) => [e.properties.pip_activation_hand_backs, e.properties.pip_activation_hand_back_repeats]);
  };
  const before = (await sentCounts()).length;

  pipCounts.notePictureInPictureHandBack({ again: false, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureHandBack({ again: true, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureHandBack({ again: false, epoch: client.consentEpoch() });
  pipCounts.notePictureInPictureHandBack({ again: false, epoch: "an epoch from before" });
  usage.sessionEnding();
  const sent = await sentCounts();
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent.at(-1), [3, 1]);

  usage.sessionEnding();
  assert.equal((await sentCounts()).length, before + 1);
});
