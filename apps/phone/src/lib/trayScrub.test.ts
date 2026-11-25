import assert from "node:assert/strict";
import test from "node:test";
import { releaseRefines, rowAt, scrubBegin, scrubEnd, scrubMove, type RowFrame } from "./trayScrub.ts";

const frames: RowFrame[] = [
  { left: 8, top: 0, right: 392, bottom: 58 },
  { left: 8, top: 58, right: 392, bottom: 116 },
  { left: 8, top: 116, right: 392, bottom: 200 },
];

test("a point finds the row under it by its laid-out frame, with 8 points of side slack, even below the visible area", () => {
  assert.equal(rowAt(frames, 200, 60), 1);
  assert.equal(rowAt(frames, 2, 10), 0);
  assert.equal(rowAt(frames, -5, 10), -1);
  assert.equal(rowAt(frames, 200, 150), 2);
  assert.equal(rowAt(frames, 200, 250), -1);
  assert.equal(rowAt([null, undefined], 10, 0), -1);
});

test("a tap highlights and activates its row without counting as a scrub", () => {
  const begun = scrubBegin(frames, 100, 20);
  assert.equal(begun.highlighted, 0);
  assert.deepEqual(scrubEnd(begun, frames, 101, 22), { kind: "activate", index: 0, wasScrubbing: false });
});

test("dragging along the rows ticks on each new row, and releasing opens the last one", () => {
  let state = scrubBegin(frames, 100, 20);
  const steps = [40, 70, 80, 150].map((y) => {
    const moved = scrubMove(state, frames, 100, y);
    state = moved.state;
    return moved.ticks;
  });
  assert.deepEqual(steps, [false, true, false, true]);
  assert.equal(state.highlighted, 2);
  assert.deepEqual(scrubEnd(state, frames, 100, 150), { kind: "activate", index: 2, wasScrubbing: true });
});

test("releasing off the rows opens nothing, and only a tap on a refinable row's arrow end refines", () => {
  let state = scrubBegin(frames, 100, 20);
  state = scrubMove(state, frames, 100, 260).state;
  assert.equal(state.highlighted, -1);
  assert.deepEqual(scrubEnd(state, frames, 100, 260), { kind: "nothing" });
  const tap = scrubEnd(scrubBegin(frames, 380, 20), frames, 380, 20);
  assert.equal(releaseRefines(tap, frames, 380, true), true);
  assert.equal(releaseRefines(tap, frames, 380, false), false);
  assert.equal(releaseRefines(tap, frames, 200, true), false);
  assert.equal(releaseRefines({ kind: "activate", index: 0, wasScrubbing: true }, frames, 380, true), false);
});
