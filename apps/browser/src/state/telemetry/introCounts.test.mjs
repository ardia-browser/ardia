import assert from "node:assert/strict";
import { test } from "node:test";
import { noteIntroEnded, noteIntroShown, noteIntroSkipped, takeIntroCounts } from "./introCounts.ts";

test("the intro counts say which scene ran, how soon the meadow drew, and whether the intro was skipped or finished", () => {
  takeIntroCounts();
  noteIntroShown(false);
  noteIntroEnded({ skipped: false, shown: "animated", firstFrameMs: 640 });
  noteIntroShown(true);
  noteIntroSkipped();
  noteIntroEnded({ skipped: true, shown: "fallback", firstFrameMs: 1210 });
  noteIntroShown(false);
  noteIntroEnded({ skipped: false, shown: "poster", firstFrameMs: null });
  noteIntroShown(false);
  noteIntroEnded({ skipped: false, shown: null, firstFrameMs: null });
  assert.deepEqual(takeIntroCounts(), {
    intros_shown: 4,
    intros_music_muted: 1,
    intros_skipped: 1,
    intros_finished: 3,
    intros_scene_animated: 1,
    intros_scene_poster: 1,
    intros_scene_fell_back: 1,
    intros_first_frame_ms: 600,
  });
  assert.deepEqual(Object.values(takeIntroCounts()), [0, 0, 0, 0, 0, 0, 0, 0]);
});
