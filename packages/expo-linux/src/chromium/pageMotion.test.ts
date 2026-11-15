import assert from "node:assert/strict";
import { test } from "node:test";
import { connectPageMotion, holdDuringMotion, notePageMotion, settledPageOpacity, type PageMotion } from "./pageMotion";

type Sent = { args: Record<string, unknown>; windowId: string };

function harness() {
  const sent: Sent[] = [];
  const base = { key: "tab", visible: true, x: 0, y: 0, width: 100, height: 100, opacity: 1, windowId: "w" };
  connectPageMotion(
    (args, windowId) => void sent.push({ args, windowId }),
    (key) => (key === "tab" ? { args: base, windowId: "w" } : null),
  );
  return sent;
}

const closing: PageMotion = {
  durationMs: 300,
  rects: [[0, 0, 100, 100], [10, 10, 80, 80], [20, 20, 60, 60], [30, 30, 40, 40]],
  opacity: [1, 0.6, 0.2, 0],
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a motion carries the card's opacity samples beside its rects, and no plain opacity", async () => {
  const sent = harness();
  assert.equal(notePageMotion("tab", closing, () => 0), true);
  await flush();
  const motion = sent.at(-1)?.args.motion as PageMotion | undefined;
  assert.deepEqual(motion?.rects, closing.rects);
  assert.deepEqual(motion?.opacity, closing.opacity);
  assert.equal("opacity" in (sent.at(-1)?.args ?? {}), false);
  assert.deepEqual([sent.at(-1)?.args.x, sent.at(-1)?.args.width], [30, 40]);
  notePageMotion("tab", null);
});

test("a late start trims the opacity samples with the rects", async () => {
  const sent = harness();
  notePageMotion("tab", closing, () => 150);
  await flush();
  const motion = sent.at(-1)?.args.motion as PageMotion | undefined;
  assert.equal(motion?.rects.length, motion?.opacity?.length);
  assert.deepEqual(motion?.opacity, [0.6, 0.2, 0]);
  assert.equal(motion?.durationMs, 200);
  assert.equal(motion?.elapsedMs, 50);
  notePageMotion("tab", null);
});

test("a show held during a closing motion leaves at the motion's last opacity, right before the hide", async () => {
  const sent = harness();
  notePageMotion("tab", closing, () => 0);
  await flush();
  const before = sent.length;
  assert.equal(holdDuringMotion({ key: "tab", visible: true, x: 30, y: 30, width: 40, height: 40 }, "w"), true);
  assert.equal(sent.length, before);
  assert.equal(holdDuringMotion({ key: "tab", visible: false }, "w"), false);
  assert.deepEqual(sent.at(-1)?.args, { key: "tab", visible: true, x: 30, y: 30, width: 40, height: 40, opacity: 0 });
  assert.equal(settledPageOpacity("tab"), undefined);
});

test("a motion replaced before its end leaves no opacity behind", async () => {
  const sent = harness();
  notePageMotion("tab", closing, () => 0);
  await flush();
  holdDuringMotion({ key: "tab", visible: true, x: 30, y: 30, width: 40, height: 40 }, "w");
  notePageMotion("tab", null);
  assert.equal("opacity" in (sent.at(-1)?.args ?? {}), false);
  assert.equal(settledPageOpacity("tab"), undefined);
});

test("a motion that runs to its end keeps its last opacity for later plain shows, until the page is hidden", async (t) => {
  harness();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  notePageMotion("tab", closing, () => 0);
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  assert.equal(settledPageOpacity("tab"), 0);
  holdDuringMotion({ key: "tab", visible: false }, "w");
  assert.equal(settledPageOpacity("tab"), undefined);
  notePageMotion("tab", { ...closing, opacity: [0, 0.5, 1, 1] }, () => 0);
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  assert.equal(settledPageOpacity("tab"), undefined);
});
