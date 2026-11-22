import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { noteTabSwitcherOverflowClick, noteTabSwitcherOverflowOpened, noteTabSwitcherPictureLate, noteTabSwitcherWheelScrolled } = await import("./tabSwitcherOpens.ts");
after(() => client.setSharing(false, "settings"));

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

test("an hour with only overflowing switcher opens, clicks and wheel scrolls sends them in usage_counts once, then they reset", async () => {
  client.setSharing(true, "onboarding");
  noteTabSwitcherOverflowOpened();
  noteTabSwitcherOverflowOpened();
  noteTabSwitcherOverflowClick();
  noteTabSwitcherWheelScrolled();
  noteTabSwitcherPictureLate();
  usage.sessionEnding();
  const sent = await usageCounts();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tab_switcher_overflow_opens, 2);
  assert.equal(sent[0].tab_switcher_overflow_clicks, 1);
  assert.equal(sent[0].tab_switcher_wheel_scrolls, 1);
  assert.equal(sent[0].tab_switcher_pictures_late, 1);
  usage.sessionEnding();
  assert.equal((await usageCounts()).length, 1);
});
