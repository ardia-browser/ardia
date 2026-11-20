import type { PictureInPictureDrag, PictureInPictureResize, PictureInPictureSkip } from "../../platform/media";
import type { PageEngine } from "../engines/engines";
import { capture, counted } from "./client";
import { nativeConsent } from "./nativeConsent";

let nothingPlaying = 0;
const backToTab: Record<PageEngine, number> = { chromium: 0, webkit: 0 };
const noDrags = () => ({ moved: 0, offCursor: 0, slowMove: 0 });
let drags = noDrags();
const clickSkips = { back: 0, ahead: 0 };
const noResizes = () => ({ started: 0, withoutCursor: 0 });
let resizes = noResizes();

export function noteAutoPictureInPictureNothingPlaying() {
  nothingPlaying++;
}

export function notePictureInPictureBackToTab(engine: PageEngine) {
  backToTab[engine]++;
}

export function notePictureInPictureDragged(drag: PictureInPictureDrag) {
  const { offCursor, slowMove } = drag;
  counted(
    nativeConsent(drag),
    () => {
      drags.moved++;
      if (offCursor) drags.offCursor++;
      if (slowMove) drags.slowMove++;
    },
    () => capture("usage_counts", { pip_drags: 1, pip_drags_off_cursor: offCursor ? 1 : 0, pip_drags_slow_move: slowMove ? 1 : 0 }, null),
  );
}

export function notePictureInPictureResized(resize: PictureInPictureResize) {
  const withoutCursor = resize.inside && !resize.cursorShown;
  counted(
    nativeConsent(resize),
    () => {
      resizes.started++;
      if (withoutCursor) resizes.withoutCursor++;
    },
    () => capture("usage_counts", { pip_resizes: 1, pip_resizes_without_cursor: withoutCursor ? 1 : 0 }, null),
  );
}

export function notePictureInPictureClickSkip(skip: PictureInPictureSkip) {
  const direction = skip.seconds < 0 ? "back" : skip.seconds > 0 ? "ahead" : null;
  if (!direction) return;
  counted(
    nativeConsent(skip),
    () => clickSkips[direction]++,
    () => capture("usage_counts", { [`pip_click_skips_${direction}`]: 1 }, null),
  );
}

export function takePictureInPictureCounts() {
  const taken = { nothingPlaying, backToTab: { ...backToTab }, drags, resizes, clickSkips: { ...clickSkips } };
  nothingPlaying = 0;
  drags = noDrags();
  resizes = noResizes();
  backToTab.chromium = 0;
  backToTab.webkit = 0;
  clickSkips.back = 0;
  clickSkips.ahead = 0;
  return taken;
}
