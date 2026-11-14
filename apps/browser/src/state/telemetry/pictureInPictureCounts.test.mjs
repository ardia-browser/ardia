import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const pipCounts = await import("./pictureInPictureCounts.ts");
after(() => client.setSharing(false, "settings"));

async function sentUsageCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events
    .filter((e) => e.event === "usage_counts")
    .map((e) => ({ chromium: e.properties.pip_back_to_tab, webkit: e.properties.pip_back_to_tab_webkit }));
}

test("going back to a tab from its Picture in Picture window is counted per engine, sent on its own, then starts again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");

  pipCounts.notePictureInPictureBackToTab("webkit");
  pipCounts.notePictureInPictureBackToTab("webkit");
  pipCounts.notePictureInPictureBackToTab("chromium");
  usage.sessionEnding();
  assert.deepEqual(await sentUsageCounts(), [{ chromium: 1, webkit: 2 }]);

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

  pipCounts.notePictureInPictureClickSkip(-10);
  pipCounts.notePictureInPictureClickSkip(10);
  pipCounts.notePictureInPictureClickSkip(10);
  pipCounts.notePictureInPictureClickSkip(10);
  pipCounts.notePictureInPictureClickSkip(0);
  usage.sessionEnding();
  const sent = await skipsSent();
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent.at(-1), [1, 3]);

  usage.sessionEnding();
  assert.equal((await skipsSent()).length, before + 1);
});
