import type { PictureInPictureActivation, PictureInPictureDrag, PictureInPictureResize, PictureInPictureSkip, PictureInPictureStandIn, PictureInPictureUnstash } from "../../platform/media";
import type { PageEngine } from "../engines/engines";
import { counted } from "./client";
import { nativeConsent } from "./nativeConsent";

let nothingPlaying = 0;
const backToTab: Record<PageEngine, number> = { chromium: 0, webkit: 0 };
let backToTabFromOtherApp = 0;
const noDrags = () => ({ moved: 0, offCursor: 0, slowMove: 0 });
let drags = noDrags();
const clickSkips = { back: 0, ahead: 0 };
const noResizes = () => ({ started: 0, withoutCursor: 0 });
let resizes = noResizes();
let handleUnstashes = 0;
const noStandIns = () => ({ pinches: 0, timeouts: 0 });
let standIns = noStandIns();
const noActivations = () => ({ asked: 0, failed: 0 });
let activations = noActivations();
const noHandBacks = () => ({ given: 0, repeats: 0 });
let handBacks = noHandBacks();

export function noteAutoPictureInPictureNothingPlaying() {
  nothingPlaying++;
}

export function notePictureInPictureBackToTab(engine: PageEngine, fromOtherApp = false) {
  backToTab[engine]++;
  if (fromOtherApp) backToTabFromOtherApp++;
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
  );
}

export function notePictureInPictureClickSkip(skip: PictureInPictureSkip) {
  const direction = skip.seconds < 0 ? "back" : skip.seconds > 0 ? "ahead" : null;
  if (!direction) return;
  counted(
    nativeConsent(skip),
    () => clickSkips[direction]++,
  );
}

export function notePictureInPictureHandleUnstash(unstash: PictureInPictureUnstash) {
  counted(
    nativeConsent(unstash),
    () => handleUnstashes++,
  );
}

export function notePictureInPictureStandIn(standIn: PictureInPictureStandIn) {
  const { pinch, timedOut } = standIn;
  counted(
    nativeConsent(standIn),
    () => {
      if (pinch) standIns.pinches++;
      if (timedOut) standIns.timeouts++;
    },
  );
}

export function notePictureInPictureActivated(activation: PictureInPictureActivation) {
  const { activated } = activation;
  counted(
    nativeConsent(activation),
    () => {
      activations.asked++;
      if (!activated) activations.failed++;
    },
  );
}

export function notePictureInPictureHandBack(handBack: { again: boolean; epoch: string }) {
  const { again } = handBack;
  counted(
    nativeConsent(handBack),
    () => {
      handBacks.given++;
      if (again) handBacks.repeats++;
    },
  );
}

export function takePictureInPictureCounts() {
  const taken = { nothingPlaying, backToTab: { ...backToTab }, backToTabFromOtherApp, drags, resizes, clickSkips: { ...clickSkips }, handleUnstashes, standIns, activations, handBacks };
  standIns = noStandIns();
  activations = noActivations();
  handBacks = noHandBacks();
  nothingPlaying = 0;
  handleUnstashes = 0;
  drags = noDrags();
  resizes = noResizes();
  backToTab.chromium = 0;
  backToTab.webkit = 0;
  backToTabFromOtherApp = 0;
  clickSkips.back = 0;
  clickSkips.ahead = 0;
  return taken;
}
