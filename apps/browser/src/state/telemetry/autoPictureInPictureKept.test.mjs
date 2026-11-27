import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
after(() => client.setSharing(false, "settings"));

async function sentUsageCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events
    .filter((e) => e.event === "usage_counts")
    .map((e) => ({ kept: e.properties.auto_pip_kept_visible, appSwitch: e.properties.auto_pip_stayed_on_app_switch, nothingPlaying: e.properties.auto_pip_nothing_playing, closedWhileAway: e.properties.auto_pip_held_after_close }));
}

test("an automatic Picture in Picture held back because nothing played is sent once with the session's counts, then starts again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");

  usage.noteAutoPictureInPictureKept("nothingPlaying", client.consentEpoch());
  usage.noteAutoPictureInPictureKept("nothingPlaying", client.consentEpoch());
  usage.noteAutoPictureInPictureKept("nothingPlaying", client.consentEpoch());
  usage.sessionEnding();
  assert.deepEqual(await sentUsageCounts(), [{ kept: 0, appSwitch: 0, nothingPlaying: 3, closedWhileAway: 0 }]);

  usage.sessionEnding();
  assert.deepEqual(await sentUsageCounts(), [{ kept: 0, appSwitch: 0, nothingPlaying: 3, closedWhileAway: 0 }]);

  usage.noteAutoPictureInPictureKept("onScreen", client.consentEpoch());
  usage.noteAutoPictureInPictureKept("appSwitch", client.consentEpoch());
  usage.noteAutoPictureInPictureKept("appSwitch", client.consentEpoch());
  usage.sessionEnding();
  assert.deepEqual(await sentUsageCounts(), [
    { kept: 0, appSwitch: 0, nothingPlaying: 3, closedWhileAway: 0 },
    { kept: 1, appSwitch: 2, nothingPlaying: 0, closedWhileAway: 0 },
  ]);
});

test("a Picture in Picture closed while away, held until the person is back, is counted on its own", async () => {
  client.setSharing(true, "onboarding");
  usage.sessionEnding();
  const before = (await sentUsageCounts()).length;
  usage.noteAutoPictureInPictureKept("closedWhileAway", client.consentEpoch());
  usage.noteAutoPictureInPictureKept("closedWhileAway", client.consentEpoch());
  usage.noteAutoPictureInPictureKept("onScreen", client.consentEpoch());
  usage.sessionEnding();
  assert.deepEqual((await sentUsageCounts()).slice(before), [{ kept: 1, appSwitch: 0, nothingPlaying: 0, closedWhileAway: 2 }]);
});

test("an automatic Picture in Picture hold that began in an earlier consent period, or carries no epoch, isn't counted and isn't kept in the local copy", async () => {
  client.setSharing(true, "onboarding");
  const earlier = client.consentEpoch();
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  usage.sessionEnding();
  const before = (await sentUsageCounts()).length;
  usage.noteAutoPictureInPictureKept("onScreen", earlier);
  usage.noteAutoPictureInPictureKept("appSwitch", "");
  usage.noteAutoPictureInPictureKept("appSwitch", client.consentEpoch());
  usage.sessionEnding();
  assert.deepEqual((await sentUsageCounts()).slice(before), [{ kept: 0, appSwitch: 1, nothingPlaying: 0, closedWhileAway: 0 }]);
  const { flushLocal } = await import("./localStore.ts");
  await flushLocal();
  const unsent = stub.telemetryLocal.records().filter((r) => r.event === "usage_counts" && r.sent === false);
  assert.deepEqual(unsent, []);
});
