import { curve, duration, springs } from "../ui/motion";
import { concentric, radius, space } from "../ui/tokens";

const DARK = {
  emptyStateFill: "rgba(34,32,33,0.92)",
  zoneRest: "rgba(255,255,255,0.6)",
  zoneBorder: "rgba(255,255,255,0.08)",
  zoneFill: "rgba(255,236,214,0.04)",
  zoneDash: "rgba(255,255,255,0.1)",
  moveHandleHoverFill: "rgba(44,42,43,0.94)",
  moveHandleHoverBorder: "rgba(255,255,255,0.22)",
  moveHandleHoverIcon: "#FFFFFFF2",
  moveSourceScrim: "rgba(0,0,0,0.14)",
};

const LIGHT: typeof DARK = {
  emptyStateFill: "rgba(255,255,255,0.92)",
  zoneRest: "rgba(0,0,0,0.55)",
  zoneBorder: "rgba(0,0,0,0.08)",
  zoneFill: "rgba(255,255,255,0.45)",
  zoneDash: "rgba(0,0,0,0.1)",
  moveHandleHoverFill: "rgba(255,255,255,0.96)",
  moveHandleHoverBorder: "rgba(0,0,0,0.18)",
  moveHandleHoverIcon: "#000000E6",
  moveSourceScrim: "rgba(0,0,0,0.06)",
};

type SplitColors = typeof DARK;

export const splitColors = (dark: boolean): SplitColors => (dark ? DARK : LIGHT);

export const ZONE_ACCENT_ALPHA = { dark: 0.16, light: 0.12 } as const;
export const MOVE_TARGET_ALPHA = { dark: 0.14, light: 0.1 } as const;

export const MOVE_HANDLE = {
  box: 22,
  glyph: 12,
  inset: space.m,
  dragSlop: 4,
  intentFraction: 0.28,
  intentCap: 96,
  borderWidth: 2,
  dashInset: 6,
} as const;

export const moveHandleRadius = () => radius.control;
export const moveTargetRadius = (cardRadius: number) => (cardRadius > 0 ? cardRadius : radius.tile);
export const moveTargetDashRadius = (cardRadius: number) => concentric(moveTargetRadius(cardRadius), MOVE_HANDLE.dashInset);

export const emptyStateRadius = () => radius.sheet;
export const EMPTY_STATE_WIDTH = 420;
export const SPLIT_ROW_HEIGHT = 36;
export const splitRowRadius = () => radius.chrome;
export const zoneRadius = () => radius.hero;
export const ZONE_DASH_INSET = 9.5;
export const zoneDashRadius = () => concentric(radius.hero, ZONE_DASH_INSET);

export const FOCUS_RING = { width: 2, gap: 1 } as const;

export const ZONE_SLIDE_MS = 110;

export const SPLIT_MOTION = {
  zoneGlow: { duration: duration.fast, easing: curve.enter },
  zoneIn: { duration: ZONE_SLIDE_MS, easing: curve.enter },
  zoneOut: { duration: ZONE_SLIDE_MS, easing: curve.exit },
  zoneSpring: springs.snappy,
  handlePresence: {
    show: { duration: duration.fast, easing: curve.enter },
    hide: { duration: duration.fast, easing: curve.exit },
  },
} as const;

export const TOAST_MS = 2600;
export const TOAST_ACTION_MS = 4000;
