import assert from "node:assert/strict";
import { test } from "node:test";
const { GROWTH, ROW_HEIGHT, EXPANDED_HEIGHT, holdPlayerCard, makePlayerMotion, revealOf, settlePlayerMotion, visibleCardHeight, windowPlayerMotion } = await import("./playerMotion.ts");
const { Animated } = await import("react-native");
const { readFileSync } = await import("node:fs");

const listClip = (motion) => -GROWTH * motion.progress.__getValue() * motion.overhang.__getValue();
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

test("media ending halfway through a hover expansion leaves no clip on the list once the last card goes, but a handoff keeps the expansion", () => {
  const motion = windowPlayerMotion("w-media-ends");
  const releaseOutgoing = holdPlayerCard(motion);
  const releaseIncoming = holdPlayerCard(motion);
  motion.state.set({ expanded: true });
  motion.progress.setValue(0.5);
  assert.equal(listClip(motion), -GROWTH / 2, "the list is clipped by the half-grown card");
  releaseOutgoing();
  assert.equal(motion.progress.__getValue(), 0.5, "another page still shows the card: the expansion carries on");
  assert.deepEqual(motion.state.get(), { expanded: true, slot: "row" });
  releaseIncoming();
  assert.equal(motion.progress.__getValue(), 0);
  assert.equal(listClip(motion) + 0, 0, "no card left, no clip");
  assert.deepEqual(motion.state.get(), { expanded: false, slot: "row" });
  assert.equal(motion.cards.current, 0);
});

test("a page's own card settles its motion when it goes, as before", () => {
  const motion = makePlayerMotion();
  const release = holdPlayerCard(motion);
  motion.state.set({ expanded: true, slot: "expanded" });
  motion.progress.setValue(1);
  motion.overhang.setValue(0);
  motion.expandedSlot.current = true;
  release();
  assert.equal(motion.progress.__getValue(), 0);
  assert.equal(motion.overhang.__getValue(), 1);
  assert.equal(motion.expandedSlot.current, false);
  assert.equal(listClip(motion) + 0, 0);
});

const sourcesOf = (reveal) =>
  Object.entries(reveal)
    .filter(([key]) => !["pin", "unpinned", "trailing"].includes(key))
    .map(([key, node]) => [key, node.source]);

test("turning Keep Playing now across profiles on or off swaps the card's motion, and its reveal follows the new one", () => {
  const pin = new Animated.Value(0);
  const local = makePlayerMotion();
  const shared = windowPlayerMotion("w-toggle");
  const sizes = { titleDrop: 7, controlsLift: 8 };
  const before = revealOf(local.progress, pin, sizes);
  const after = revealOf(shared.progress, pin, sizes);
  for (const [key, source] of sourcesOf(before)) assert.equal(source, local.progress, `${key} follows the page's own motion`);
  for (const [key, source] of sourcesOf(after)) assert.equal(source, shared.progress, `${key} follows the window's motion once the setting is on`);
  assert.equal(after.mask.config.outputRange[0], GROWTH);
  assert.deepEqual(after.titleDrop.config.outputRange, [7, 0]);
  assert.deepEqual(after.controlsLift.config.outputRange, [-GROWTH + 8, 0]);
  assert.equal(after.pin, pin, "the trailing pin is the card's own and stays");
});

test("the card rebuilds its reveal when its motion's progress changes, and its expansion effects rerun on a new motion", () => {
  const source = readFileSync(new URL("./SidebarPlayer.tsx", import.meta.url), "utf8");
  assert.match(source, /useMemo\(\(\) => revealOf\(progress, pin, [^\n]*\), \[progress, pin\]\)/, "the reveal is built from the current progress, not once");
  assert.doesNotMatch(source, /useState\(\(\) => \(\{\s*pin,/, "no reveal frozen in state");
  assert.match(source, /\}, \[want, expanded, leads, motion\]\);/);
  assert.match(source, /\}, \[expanded, slot, leads, motion\]\);/);
});
