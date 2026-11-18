import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { setToolbarAnchor, toolbarAnchor } = await import("./toolbarAnchors.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();

async function sentCounts() {
  usage.sessionEnding();
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  const events = queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
  return events.at(-1) ?? {};
}

test("a popup opens at its button's place measured now, not where it was when the toolbar last laid out", async () => {
  client.setSharing(true, "onboarding");
  S().hydrate({});
  const w = S().createWindow({});
  const tab = model.activeTabId(S(), w);
  const cached = { x: 900, y: 12, width: 28, height: 28 };
  const moved = { x: 640, y: 12, width: 28, height: 28 };
  setToolbarAnchor(w, tab, "ext", cached, async () => moved);
  assert.deepEqual(await toolbarAnchor(w, "ext", tab), moved);
  setToolbarAnchor(w, tab, "ext", moved, async () => moved);
  assert.deepEqual(await toolbarAnchor(w, "ext", tab), moved);
  setToolbarAnchor(w, tab, "ext", cached, () => new Promise(() => {}));
  const started = Date.now();
  assert.deepEqual(await toolbarAnchor(w, "ext", tab), cached, "a button that doesn't answer keeps its last known place");
  assert.ok(Date.now() - started < 1000);
  assert.equal((await toolbarAnchor(w, "unpinned", "elsewhere")).x, 100_000, "an extension with no button opens off the toolbar, as before");
  const sent = await sentCounts();
  assert.equal(sent.toolbar_anchor_moves, 1);
  assert.equal(sent.toolbar_anchor_misses, 1);
});
