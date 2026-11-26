import assert from "node:assert/strict";
import { test } from "node:test";
import { noteIntroEnded, noteIntroShown, noteIntroSkipped, takeIntroCounts } from "./introCounts.ts";
import { consentToken, setConsentPeriod } from "./consentPeriod.ts";

test("the intro counts say which scene ran, how soon the meadow drew, and whether the intro was skipped or finished", () => {
  setConsentPeriod(true, "intro-period");
  const consent = consentToken();
  takeIntroCounts();
  noteIntroShown(false);
  noteIntroEnded({ skipped: false, shown: "animated", firstFrameMs: 640 }, consent);
  noteIntroShown(true);
  noteIntroSkipped(consent);
  noteIntroEnded({ skipped: true, shown: "fallback", firstFrameMs: 1210 }, consent);
  noteIntroShown(false);
  noteIntroEnded({ skipped: false, shown: "poster", firstFrameMs: null }, consent);
  noteIntroShown(false);
  noteIntroEnded({ skipped: false, shown: null, firstFrameMs: null }, consent);
  assert.deepEqual(takeIntroCounts(), {
    intros_shown: 4,
    intros_music_muted: 1,
    intros_skipped: 1,
    intros_finished: 3,
    intros_scene_animated: 1,
    intros_scene_poster: 1,
    intros_scene_fell_back: 1,
    intros_first_frame_ms: 600,
    intros_music_failed: 0,
  });
  assert.deepEqual(Object.values(takeIntroCounts()), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("an intro that ends after sharing was turned off counts nothing", () => {
  setConsentPeriod(true, "before");
  const consent = consentToken();
  takeIntroCounts();
  setConsentPeriod(false, null);
  noteIntroSkipped(consent);
  noteIntroEnded({ skipped: false, shown: "animated", firstFrameMs: 500 }, consent);
  const counts = takeIntroCounts();
  assert.equal(counts.intros_skipped, 0);
  assert.equal(counts.intros_finished, 0);
});
