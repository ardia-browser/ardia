import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const RN = await import("react-native");
const { emitAppEvent } = await import("../../test-native/shell.ts");
const { S, mount, sceneLayout, settle, entryKey } = await import("./fixtures/dragScene.mjs");
const { stripDragHandoff } = await import("./stripDrag.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function heldScene() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://first.example", frame: [0, 0, 1200, 800] });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://second.example", background: true });
  const { c, ghosts } = mount({ entries: sceneLayout().row(a).row(b).entries });
  c.windowId = w;
  c.root.held = true;
  return { w, a, c, ghosts };
}

async function leftWhileMeasuring(leave) {
  const { w, a, c, ghosts } = heldScene();
  const drag = stripDragHandoff(w, entryKey("tab", a), () => {}, 1, () => c);
  drag.press();
  drag.begin(20, 210);
  await tick(30);
  assert.equal(c.active, true, "the sidebar's drag has begun measuring");
  assert.equal(c.root.pending.length, 1);
  leave();
  c.root.release();
  await settle();
  await settle();
  const seen = { active: c.active, shown: ghosts.filter(Boolean).length };
  drag.end(false);
  return seen;
}

test("the app going inactive while the sidebar's drag is still measuring abandons it with no ghost", async () => {
  const listeners = [];
  const real = RN.AppState.addEventListener;
  RN.AppState.addEventListener = (_type, listener) => (listeners.push(listener), { remove: () => listeners.splice(listeners.indexOf(listener), 1) });
  try {
    assert.deepEqual(await leftWhileMeasuring(() => listeners.forEach((l) => l("inactive"))), { active: false, shown: 0 });
  } finally {
    RN.AppState.addEventListener = real;
  }
});

test("the app resigning active while the sidebar's drag is still measuring abandons it with no ghost", async () => {
  assert.deepEqual(await leftWhileMeasuring(() => emitAppEvent({ type: "resignActive" })), { active: false, shown: 0 });
});

test("a drag still measuring when nothing leaves goes on to show its ghost", async () => {
  assert.deepEqual(await leftWhileMeasuring(() => {}), { active: true, shown: 1 });
});
