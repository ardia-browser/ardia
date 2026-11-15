import { curve, duration, springs } from "../ui/motion";
import { CARD_INSET } from "../../lib/windowLayout";
import { SMALL_BAR_BUTTON, SMALL_BAR_GAP } from "../littleArdia/tokens";

export const PEEK_SCRIM = { dark: "rgba(0,0,0,0.45)", light: "rgba(0,0,0,0.25)" } as const;

export const PEEK_MOTION = {
  grow: springs.snappy,
  fadeIn: { duration: duration.base, easing: curve.enter },
  close: { duration: duration.base, easing: curve.exit },
  expand: { duration: duration.base, easing: curve.enter },
} as const;

export const PEEK_MARK = { scale: 0.625, plate: 1.5, radius: 3.5 } as const;

export const PEEK_NAV_PITCH = SMALL_BAR_BUTTON + SMALL_BAR_GAP;

export const PEEK_HISTORY_CENTERS = { back: CARD_INSET + SMALL_BAR_BUTTON / 2, forward: CARD_INSET + PEEK_NAV_PITCH + SMALL_BAR_BUTTON / 2 } as const;
