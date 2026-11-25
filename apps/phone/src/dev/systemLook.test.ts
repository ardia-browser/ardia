import assert from "node:assert/strict";
import { test } from "node:test";
import { createSystemLookStore, type SystemLookNow } from "../../../../packages/phone/src/systemLookRules.ts";

function fake(initial: SystemLookNow | null) {
  let native = initial;
  let changed: ((now: SystemLookNow) => void) | null = null;
  let resumed: (() => void) | null = null;
  let watching = 0;
  const store = createSystemLookStore({
    read: () => native,
    readLater: async () => ({ reduceMotion: true, reduceTransparency: true }),
    watch: (listener) => {
      watching += 1;
      changed = listener;
      return () => {
        watching -= 1;
        changed = null;
      };
    },
    onResume: (listener) => {
      resumed = listener;
      return () => (resumed = null);
    },
  });
  return { store, set: (now: SystemLookNow) => (native = now), fire: (now: SystemLookNow) => changed?.(now), resume: () => resumed?.(), watching: () => watching };
}

test("a setting changed while running reaches every reader at once, and a no-change event renders nothing", () => {
  const world = fake({ reduceMotion: false, reduceTransparency: false });
  let renders = 0;
  const stop = world.store.subscribe(() => (renders += 1));
  world.fire({ reduceMotion: true, reduceTransparency: false });
  assert.equal(world.store.get().reduceMotion, true);
  assert.equal(renders, 1);
  world.fire({ reduceMotion: true, reduceTransparency: false });
  assert.equal(renders, 1);
  stop();
  assert.equal(world.watching(), 0, "the last reader leaving stops the watch");
});

test("a resume re-reads the setting, so a change missed while in the background still lands", () => {
  const world = fake({ reduceMotion: true, reduceTransparency: false });
  world.store.subscribe(() => undefined);
  world.set({ reduceMotion: false, reduceTransparency: false });
  assert.equal(world.store.get().reduceMotion, true);
  world.resume();
  assert.equal(world.store.get().reduceMotion, false, "turning Remove animations off is picked up on resume");
});

test("the snapshot is the same object until something changes, as useSyncExternalStore needs", () => {
  const world = fake({ reduceMotion: false, reduceTransparency: false });
  const first = world.store.get();
  world.store.subscribe(() => undefined);
  assert.equal(world.store.get(), first);
  world.fire({ reduceMotion: false, reduceTransparency: true });
  assert.notEqual(world.store.get(), first);
});

test("without a native read the store asks the platform later", async () => {
  const world = fake(null);
  assert.equal(world.store.get().reduceMotion, false);
  world.store.subscribe(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(world.store.get(), { reduceMotion: true, reduceTransparency: true });
});
