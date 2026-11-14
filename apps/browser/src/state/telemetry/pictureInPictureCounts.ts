import type { PageEngine } from "../engines/engines";
import type { PictureInPictureDrag } from "../../platform/media";

let nothingPlaying = 0;
const backToTab: Record<PageEngine, number> = { chromium: 0, webkit: 0 };
const drags = { total: 0, held: 0, slipped: 0 };
const clickSkips = { back: 0, ahead: 0 };

export function noteAutoPictureInPictureNothingPlaying() {
  nothingPlaying++;
}

export function notePictureInPictureBackToTab(engine: PageEngine) {
  backToTab[engine]++;
}

export function notePictureInPictureDragged({ held, slipped }: PictureInPictureDrag) {
  drags.total++;
  if (held) drags.held++;
  if (slipped) drags.slipped++;
}

export function notePictureInPictureClickSkip(seconds: number) {
  if (seconds < 0) clickSkips.back++;
  else if (seconds > 0) clickSkips.ahead++;
}

export function takePictureInPictureCounts() {
  const taken = { nothingPlaying, backToTab: { ...backToTab }, clickSkips: { ...clickSkips }, drags: { ...drags } };
  nothingPlaying = 0;
  drags.total = 0;
  drags.held = 0;
  drags.slipped = 0;
  backToTab.chromium = 0;
  backToTab.webkit = 0;
  clickSkips.back = 0;
  clickSkips.ahead = 0;
  return taken;
}
