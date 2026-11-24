import assert from "node:assert/strict";
import { test } from "node:test";

const { DragItems } = await import("./dragItems.ts");

function folded(away) {
  const listeners = new Set();
  return {
    away: () => away,
    set(next) {
      away = next;
      for (const changed of [...listeners]) changed();
    },
    subscribe(changed) {
      listeners.add(changed);
      return () => void listeners.delete(changed);
    },
  };
}

const controller = (active = false) => ({
  items: new Map(),
  active,
  releaseGap(item) {
    item.gap.stopAnimation();
    item.gap.setValue(0);
  },
});

function row(key) {
  let gap = 0;
  return { key, frame: { x: 0, y: 100, w: 180, h: 30 }, headerFrame: null, gap: { stopAnimation() {}, setValue: (v) => (gap = v), value: () => gap } };
}

test("a row hidden in a closed folder is no drag target, and becomes one again when the folder opens", () => {
  const c = controller();
  const items = new DragItems(c, true);
  const r = row("tab:t1");
  const shown = folded(true);
  const stop = items.addWhileShown(r.key, r, shown);
  assert.equal(c.items.has(r.key), false, "a row mounted inside a closed folder isn't registered");
  shown.set(false);
  assert.equal(c.items.get(r.key), r, "opening the folder registers it");
  shown.set(true);
  assert.equal(c.items.has(r.key), false, "closing the folder takes it out again");
  shown.set(false);
  stop();
  assert.equal(c.items.has(r.key), false, "unmounting removes it");
});

test("a row its folder hides during a drag forgets its frame and gap, so it's no target until the next drag measures it", () => {
  const c = controller(true);
  const items = new DragItems(c, true);
  const r = row("tab:t2");
  r.gap.setValue(33);
  const shown = folded(false);
  items.addWhileShown(r.key, r, shown);
  shown.set(true);
  assert.equal(r.gap.value(), 0);
  assert.equal(r.frame, null);
  shown.set(false);
  assert.equal(c.items.get(r.key), r);
  assert.equal(r.frame, null, "back in the list, it waits for a full measure like any row that mounts mid-drag");
});
