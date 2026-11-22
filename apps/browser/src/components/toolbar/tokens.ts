import { curve, duration } from "../ui/motion";
import { TOOLBAR_ROWS } from "../../lib/toolbarRow";

export const GLYPH = 13;

export const SYMBOL_BOX = 16;

export const HISTORY_GLYPH = { size: GLYPH, weight: "medium" } as const;

export const TOOLBAR_MOTION = { dim: duration.base, hide: duration.base, show: duration.base, settle: 0 } as const;

export const RELOAD_BUTTON_MOTION = {
  stateIn: duration.base,
  stateOut: duration.slow,
  breatheCycle: 1420,
  hiddenScale: 0.72,
  breatheScale: [0.96, 1.06],
  breatheOpacity: [0.86, 1],
  returnRotation: 28,
} as const;

export const FIELD_LOAD = {
  floor: 0.1,
  accentApartFromBand: 0.25,
  tail: 120,
  frontShareOfField: 0.4,
  tailFade: [1, 0.55, 0.38, 0.33, 0.3, 0],
  tailCeiling: 0.2,
  cap: 72,
  capFade: [1, 0.78, 0.59, 0.43, 0.3, 0.19, 0.11, 0.05, 0.01, 0],
  line: 1.5,
  glow: [
    [0, 0.08],
    [0.07, 0.13],
    [0.45, 0.17],
    [0.65, 0.2],
    [0.78, 0.28],
    [0.87, 0.4],
    [0.94, 0.6],
    [1, 0.7],
  ],
  motion: {
    show: { duration: 200, easing: curve.enter },
    progress: { duration: duration.slow, easing: curve.enter },
    finish: { duration: 300, easing: curve.enter },
    hold: 200,
    hide: { duration: duration.slow, easing: curve.exit },
  },
} as const;

export const HISTORY_BUTTON_MOTION = {
  duration: duration.slow + 50,
  incomingDelay: 35,
  travel: 4,
} as const;

export const DEVELOPER_ROW = { ...TOOLBAR_ROWS.compact, height: 34, center: 17, button: 24, buttonRadius: 6, extensionButton: 24 };

export const DEVELOPER_BAR = {
  height: DEVELOPER_ROW.height,
  stripeOpacity: { lightInk: 0.025, darkInk: 0.035 },
  urlSize: 11,
  dividerLength: 14,
  leadingEdge: 7,
  trailingEdge: 5,
  urlGap: 6,
  groupGap: 7.5,
  glyph: 15,
  extensionsGlyph: 14,
} as const;
