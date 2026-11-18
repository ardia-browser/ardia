import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { noteSidebarResize, watchSidebarResizeFrames } = await import("./sidebarResizeCounts.ts");
after(() => client.setSharing(false, "settings"));

async function sentUsage() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts").map((e) => e.properties);
}

async function sentSidebarResizes() {
  return (await sentUsage()).map((p) => p.sidebar_resizes);
}

function frameClock() {
  const pending = new Map();
  let next = 0;
  globalThis.requestAnimationFrame = (callback) => (pending.set(++next, callback), next);
  globalThis.cancelAnimationFrame = (id) => pending.delete(id);
  return {
    frame(at) {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback(at);
    },
    waiting: () => pending.size,
  };
}

test("an hour with only sidebar resizes still sends usage_counts, and the count starts again from zero", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");

  noteSidebarResize(true);
  noteSidebarResize(true);
  noteSidebarResize(false);
  usage.sessionEnding();
  assert.deepEqual(await sentSidebarResizes(), [2]);

  usage.sessionEnding();
  assert.deepEqual(await sentSidebarResizes(), [2]);
});

test("a resize drag counts the frames it took and the ones that came more than 25 ms late; a click on the edge counts none", async () => {
  const clock = frameClock();
  watchSidebarResizeFrames();
  for (const at of [0, 8, 16, 24, 74, 82]) clock.frame(at);
  noteSidebarResize(true);
  assert.equal(clock.waiting(), 0);

  watchSidebarResizeFrames();
  for (const at of [100, 200, 300]) clock.frame(at);
  noteSidebarResize(false);
  assert.equal(clock.waiting(), 0);

  usage.sessionEnding();
  const last = (await sentUsage()).at(-1);
  assert.equal(last.sidebar_resizes, 1);
  assert.equal(last.sidebar_resize_frames, 5);
  assert.equal(last.sidebar_resize_slow_frames, 1);
});
