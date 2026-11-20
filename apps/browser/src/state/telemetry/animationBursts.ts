import { animationBursts } from "../../platform/motion";
import { capture, consentEpoch, counted } from "./client";
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
      () => capture("usage_counts", { animation_bursts: 1, animation_long_frames: burst.long }, null),
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
