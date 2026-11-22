import { animationBursts } from "../../platform/motion";
import { consentEpoch, counted } from "./client";
import { nativeConsent } from "./nativeConsent";

let bursts = 0;
let longFrames = 0;

export function watchAnimationBursts() {
  animationBursts.onBurst((burst) =>
    counted(
      nativeConsent(burst),
      () => {
        bursts += 1;
        longFrames += burst.long;
      },
    ),
    consentEpoch,
  );
}

export function takeAnimationBursts() {
  const taken = { animation_bursts: bursts, animation_long_frames: longFrames };
  bursts = 0;
  longFrames = 0;
  return taken;
}
