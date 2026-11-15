import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
await import("./windowOcclusionCounts.ts");
after(() => client.setSharing(false, "settings"));

const chromeWindow = (key, chromeOccluded, occlusionVisible = true) => ({
  profile: "Default", window: key ? 1 : 2, frame: "{{0, 0}, {1512, 949}}", alpha: 1, key, canBecomeKey: true, visible: true,
  parentWindow: 0, chromeWindows: 1, anchorBrowserId: 0, anyTabBrowserId: 0, ready: true, active: key, pageInsets: [0, 0, 0, 0],
  hosting: true, group: "", hasRoot: true, translucent: false, occlusionVisible, chromeOccluded,
});

async function sentCounts() {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === "usage_counts").map((e) => [e.properties.focused_window_checks, e.properties.focused_window_pages_occluded]);
}

test("a focused window whose pages Chrome holds occluded while macOS shows it is counted once its focus settles, and the counts start again from zero", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  client.loadChoice();
  client.setSharing(true, "onboarding");
  const settle = async (list) => {
    stub.chromeWindowList.splice(0, Infinity, ...list);
    t.mock.timers.tick(1500);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  stub.windows.emit({ type: "focus", id: "w1" });
  t.mock.timers.tick(1000);
  stub.windows.emit({ type: "focus", id: "w2" });
  t.mock.timers.tick(1000);
  await settle([chromeWindow(true, true), chromeWindow(false, true)]);
  stub.windows.emit({ type: "focus", id: "w1" });
  await settle([chromeWindow(true, false), chromeWindow(false, true)]);
  stub.windows.emit({ type: "focus", id: "w2" });
  await settle([chromeWindow(true, true, false)]);
  t.mock.timers.reset();
  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), [[3, 1]]);

  usage.sessionEnding();
  assert.deepEqual(await sentCounts(), [[3, 1]]);
});
