import assert from "node:assert/strict";
import { test } from "node:test";
const { GROWTH, ROW_HEIGHT, EXPANDED_HEIGHT, makePlayerMotion, settlePlayerMotion, visibleCardHeight, windowPlayerMotion } = await import("./playerMotion.ts");

const visibleTop = (bottom, motion) => bottom - visibleCardHeight(motion.state.get().slot, motion.progress.__getValue());

test("the card grows upward from a fixed bottom: a row, then the expanded card once it settles", () => {
  const motion = makePlayerMotion();
  assert.equal(visibleCardHeight("row", 0), ROW_HEIGHT);
  assert.equal(visibleCardHeight("row", 0.5), ROW_HEIGHT + GROWTH / 2);
  assert.equal(visibleCardHeight("row", 1), EXPANDED_HEIGHT);
  assert.equal(visibleCardHeight("expanded", 1), EXPANDED_HEIGHT);
  assert.equal(visibleTop(600, motion), 600 - ROW_HEIGHT);
});

test("with a card per page, an outgoing card halfway expanded and a collapsed incoming one sit 27 pt apart at the handoff", () => {
  const outgoing = makePlayerMotion();
  const incoming = makePlayerMotion();
  outgoing.state.set({ expanded: true });
  outgoing.progress.setValue(0.5);
  assert.equal(GROWTH / 2, 27);
  assert.equal(visibleTop(600, incoming) - visibleTop(600, outgoing), 27, "the jump the shared motion removes");
});

test("pages that share the window's card share one expansion: the expanded outgoing card and the incoming one are the same height through the handoff", () => {
  const outgoing = windowPlayerMotion("w-handoff");
  const incoming = windowPlayerMotion("w-handoff");
  assert.equal(incoming, outgoing, "one motion for every page of the window");
  assert.notEqual(windowPlayerMotion("w-other"), outgoing, "another window has its own");
  assert.equal(outgoing.shared, true);
  assert.equal(makePlayerMotion().shared, false);
  outgoing.state.set({ expanded: true });
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    outgoing.progress.setValue(progress);
    assert.deepEqual(incoming.state.get(), { expanded: true, slot: "row" });
    assert.equal(visibleTop(600, incoming), visibleTop(600, outgoing), `same top at ${progress}`);
  }
  outgoing.state.set({ slot: "expanded" });
  assert.equal(visibleTop(600, incoming), 600 - EXPANDED_HEIGHT);
  assert.equal(visibleTop(600, incoming), visibleTop(600, outgoing), "and once it settles expanded");
  settlePlayerMotion(outgoing);
  assert.deepEqual(incoming.state.get(), { expanded: false, slot: "row" });
  assert.equal(incoming.progress.__getValue(), 0);
});

test("the expansion store tells its listeners only about real changes", () => {
  const motion = makePlayerMotion();
  let told = 0;
  const stop = motion.state.subscribe(() => told++);
  motion.state.set({ expanded: false });
  motion.state.set({ expanded: true });
  motion.state.set({ expanded: true });
  motion.state.set({ slot: "expanded" });
  stop();
  motion.state.set({ slot: "row" });
  assert.equal(told, 2);
});
