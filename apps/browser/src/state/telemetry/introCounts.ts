export type IntroScene = "animated" | "poster" | "fallback";

const FIRST_FRAME_STEP_MS = 100;

let shown = 0;
let mutedAtStart = 0;
let skipped = 0;
let finished = 0;
let scenes: Record<IntroScene, number> = { animated: 0, poster: 0, fallback: 0 };
let firstFrameMs = 0;

export function noteIntroShown(musicMuted: boolean) {
  shown += 1;
  if (musicMuted) mutedAtStart += 1;
}

export const noteIntroSkipped = () => void (skipped += 1);

export function noteIntroEnded(ended: { skipped: boolean; shown: IntroScene | null; firstFrameMs: number | null }) {
  if (!ended.skipped) finished += 1;
  if (ended.shown) scenes[ended.shown] += 1;
  if (ended.shown === "animated" && ended.firstFrameMs !== null) firstFrameMs += Math.round(Math.max(0, ended.firstFrameMs) / FIRST_FRAME_STEP_MS) * FIRST_FRAME_STEP_MS;
}

export function takeIntroCounts() {
  const taken = {
    intros_shown: shown,
    intros_music_muted: mutedAtStart,
    intros_skipped: skipped,
    intros_finished: finished,
    intros_scene_animated: scenes.animated,
    intros_scene_poster: scenes.poster,
    intros_scene_fell_back: scenes.fallback,
    intros_first_frame_ms: firstFrameMs,
  };
  shown = 0;
  mutedAtStart = 0;
  skipped = 0;
  finished = 0;
  scenes = { animated: 0, poster: 0, fallback: 0 };
  firstFrameMs = 0;
  return taken;
}
