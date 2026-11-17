import assert from "node:assert/strict";
import test from "node:test";
import { interactionLine, lookTotalsBetween, summarizeFrames } from "./framePerf.ts";

test("a frame summary gives the median, the 90th percentile, the worst frame and the frames over one and a half budgets", () => {
  const summary = summarizeFrames([16.7, 16.7, 16.7, 33.3, 16.7, 50, 16.7, 16.7, 16.7, 16.7]);
  assert.equal(summary.frames, 10);
  assert.equal(summary.p50, 16.7);
  assert.equal(summary.p90, 33.3);
  assert.equal(summary.max, 50);
  assert.equal(summary.overBudget, 2);
  assert.deepEqual(summarizeFrames([]), { frames: 0, p50: 0, p90: 0, max: 0, overBudget: 0 });
  assert.equal(summarizeFrames([0, -1, Number.NaN, 20]).frames, 1);
});

test("an interaction prints one lab line with both threads and the renders by component", () => {
  const js = summarizeFrames([16.7, 33.3]);
  const ui = summarizeFrames([16.7, 16.7]);
  assert.equal(
    interactionLine("card open", 900, js, ui, new Map([["TabDeck", 2], ["DeckCard", 18]])),
    "PAGELAB perf card open 900ms | js 2 frames p50 16.7 p90 33.3 max 33.3 slow 1 | ui 2 frames p50 16.7 p90 16.7 max 16.7 slow 0 | renders 20 (DeckCard=18 TabDeck=2) | look unmeasured",
  );
  assert.equal(
    interactionLine("tray open", 800, js, null, new Map(), { recording: 0, holdingLayers: 0, animating: 0 }),
    "PAGELAB perf tray open 800ms | js 2 frames p50 16.7 p90 33.3 max 33.3 slow 1 | ui unmeasured | renders 0 | look at end recording 0 holding 0 animating 0",
  );
});

test("the look field says what the look did during the window, from its running totals at the window's start and end, beside its state at the end", () => {
  const js = summarizeFrames([16.7]);
  const during = lookTotalsBetween({ backdropFrames: 40, sourceRecordings: 3, blurLayerRenders: 7, retints: 1 }, { backdropFrames: 52, sourceRecordings: 3, blurLayerRenders: 9, retints: 1 });
  assert.deepEqual(during, { backdropFrames: 12, sourceRecordings: 0, blurLayerRenders: 2, retints: 0 });
  assert.equal(
    interactionLine("deck scroll", 1200, js, null, new Map(), { recording: 0, holdingLayers: 0, animating: 1, during }),
    "PAGELAB perf deck scroll 1200ms | js 1 frames p50 16.7 p90 16.7 max 16.7 slow 0 | ui unmeasured | renders 0 | look drew backdrop 12, recorded 0, blurred 2, retinted 0; at end recording 0 holding 0 animating 1",
  );
  assert.equal(lookTotalsBetween(null, { backdropFrames: 1, sourceRecordings: 0, blurLayerRenders: 0, retints: 0 }), null);
});
