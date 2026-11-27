import assert from "node:assert/strict";
import { test } from "node:test";
import { Animated } from "react-native";
const { sharedTileSides, sharedTilesMotion, stationaryPlayerMotion } = await import("./sharedTiles.ts");

const at = ({ config }, pos) => {
  const { inputRange: x, outputRange: y } = config;
  if (pos <= x[0]) return y[0];
  if (pos >= x.at(-1)) return y.at(-1);
  const i = x.findIndex((v, n) => pos >= v && pos <= x[n + 1]);
  return y[i] + ((pos - x[i]) / (x[i + 1] - x[i])) * (y[i + 1] - y[i]);
};

const profiles = {
  lone: { id: "lone", dataId: "home" },
  home: { id: "home", shareTopApps: true },
  work: { id: "work", dataId: "home", shareTopApps: true },
  solo: { id: "solo", shareTopApps: true },
  side: { id: "side", dataId: "solo", shareTopApps: true },
};
const state = { profiles, profileOrder: ["lone", "home", "work", "solo", "side"] };

test("a page's Top Apps hold still only toward a neighbour that shares the same set", () => {
  assert.deepEqual(sharedTileSides(state, 0), { before: false, after: false }, "the neighbour shares but this profile doesn't");
  assert.deepEqual(sharedTileSides(state, 1), { before: false, after: true });
  assert.deepEqual(sharedTileSides(state, 2), { before: true, after: false }, "the next profile shares a different set");
  assert.deepEqual(sharedTileSides(state, 3), { before: false, after: true });
  assert.deepEqual(sharedTileSides(state, 4), { before: true, after: false });
});

test("shared Top Apps stay where they are for the whole switch and cross-fade, unshared ones ride their page", () => {
  const width = 260;
  const pos = new Animated.Value(1);
  const page = (slot, p) => (p - slot) * -width;
  const home = sharedTilesMotion(pos, 1, width, sharedTileSides(state, 1));
  const work = sharedTilesMotion(pos, 2, width, sharedTileSides(state, 2));
  for (const p of [1, 1.1, 1.25, 1.5, 1.8, 2]) {
    assert.ok(Math.abs(page(1, p) + at(home.transform[0].translateX, p)) < 1e-9, `home's grid at ${p}`);
    assert.ok(Math.abs(page(2, p) + at(work.transform[0].translateX, p)) < 1e-9, `work's grid at ${p}`);
    assert.ok(Math.abs(at(home.opacity, p) + at(work.opacity, p) - 1) < 1e-9, `the two grids add up to one at ${p}`);
  }
  for (const p of [2, 2.4, 3]) assert.equal(at(work.transform[0].translateX, p), 0, `work's grid slides with its page toward solo at ${p}`);
  assert.equal(at(work.opacity, 2.5), 1);
  assert.equal(at(home.opacity, 0.5), 1, "home's grid slides with its page toward lone");
  assert.equal(at(home.transform[0].translateX, 0.5), 0);
});

test("a Playing now card shown on every profile's page stays put through a swipe and hands over at the midpoint, never fading both", () => {
  const width = 260;
  const pos = new Animated.Value(0);
  const page = (slot, p) => (p - slot) * -width;
  const first = stationaryPlayerMotion(pos, 0, width, { before: false, after: true });
  const middle = stationaryPlayerMotion(pos, 1, width, { before: true, after: true });
  const last = stationaryPlayerMotion(pos, 2, width, { before: true, after: false });
  for (const p of [0, 0.2, 0.49, 0.51, 0.9, 1]) {
    assert.ok(Math.abs(page(0, p) + at(first.transform[0].translateX, p)) < 1e-9, `the first page's card at ${p}`);
    assert.ok(Math.abs(page(1, p) + at(middle.transform[0].translateX, p)) < 1e-9, `the second page's card at ${p}`);
    assert.equal(Math.max(at(first.opacity, p), at(middle.opacity, p)), 1, `one card is fully shown at ${p}`);
    assert.ok(at(first.opacity, p) === 0 || at(middle.opacity, p) === 0 || p === 0.5, `never two half-faded cards at ${p}`);
  }
  assert.equal(at(first.opacity, 0.4), 1);
  assert.equal(at(middle.opacity, 0.4), 0);
  assert.equal(at(first.opacity, 0.6), 0);
  assert.equal(at(middle.opacity, 0.6), 1);
  for (const p of [1.2, 1.7, 2]) assert.ok(Math.abs(page(2, p) + at(last.transform[0].translateX, p)) < 1e-9, `the last page's card at ${p}`);
  const lone = stationaryPlayerMotion(pos, 0, width, { before: false, after: false });
  assert.equal(at(lone.transform[0].translateX, 0.5), 0, "with no neighbour the card rides its page");
  assert.equal(at(lone.opacity, 0.5), 1);
});

test("a card raised by one page's docked New Tab row and a lower one on a short page meet halfway, so the handoff never jumps up or down", () => {
  const width = 260;
  const pos = new Animated.Value(0);
  const page = (slot, p) => (p - slot) * -width;
  const tall = { top: 600 };
  const short = { top: 640 };
  const overflowing = stationaryPlayerMotion(pos, 0, width, { before: false, after: true }, { before: 0, after: short.top - tall.top });
  const shortPage = stationaryPlayerMotion(pos, 1, width, { before: true, after: false }, { before: tall.top - short.top, after: 0 });
  const seen = (p) => {
    const shown = at(overflowing.opacity, p) === 1 ? [overflowing, 0, tall] : [shortPage, 1, short];
    const [motion, slot, own] = shown;
    return { x: page(slot, p) + at(motion.transform[0].translateX, p), y: own.top + at(motion.transform[1].translateY, p) };
  };
  assert.deepEqual(seen(0), { x: 0, y: tall.top });
  assert.deepEqual(seen(1), { x: 0, y: short.top });
  let last = seen(0).y;
  for (let p = 0.05; p <= 1.0001; p += 0.05) {
    const { x, y } = seen(p);
    assert.ok(Math.abs(x) < 1e-9, `the card holds its place across at ${p}`);
    assert.ok(y - last >= 0 && y - last <= 2 + 1e-9, `it moves down at most 2 pt a twentieth of the swipe at ${p}, never a jump (from ${last} to ${y})`);
    last = y;
  }
  const below = seen(0.4999).y;
  const above = seen(0.5001).y;
  assert.ok(Math.abs(above - below) < 0.1, `both cards sit at the same height at the handoff (${below} and ${above})`);
});
