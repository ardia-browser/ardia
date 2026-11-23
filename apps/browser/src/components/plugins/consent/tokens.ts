import { curve, duration } from "../../ui/motion";
import { concentric, radius, sheetWidth, space } from "../../ui/tokens";

const INSET = space.xxl;
const LIST_INSET = space.m;

export const CONSENT_SHEET = {
  size: "m",
  inset: INSET,
  listInset: LIST_INSET,
  get groupRadius() {
    return concentric(radius.sheet, LIST_INSET);
  },
  icon: { box: 52, glyph: 26 },
  iconFill: "#636366",
  iconSheen: 0.14,
  iconEdge: { dark: 0.16, light: 0.12 },
  seal: 11,
  sealLift: 1,
  headerGap: space.ml,
  metaGap: space.xxs,
  descriptionGap: space.s,
  descriptionLines: 3,
  nameLines: 2,
  listGap: space.xl - space.xxs,
  sectionGap: space.xl,
  sectionTitleGap: space.s,
  rowPadX: space.l,
  rowPadY: space.m,
  rowIcon: { box: 18, glyph: 13 },
  rowGap: space.ml,
  detailGap: space.xxs,
  chipGap: space.xs,
  chipsGap: space.s,
  chipPadX: space.s,
  chipPadY: space.xxs,
  footerGap: space.xl,
  footerHeight: 22,
  bar: { width: 180, height: 4, segment: 0.32, track: 0.1, trackContrast: 0.2 },
  statusGlyph: 14,
  statusBox: 16,
  maxHeight: "96%",
  fade: space.xl,
  fadeBands: 8,
  width: sheetWidth.m - 2 * INSET,
} as const;

export const CONSENT_MOTION = {
  phase: { duration: duration.base, easing: curve.fade },
  fraction: { duration: duration.base, easing: curve.enter },
  sweepMs: 1200,
  pulseMs: 1100,
  pulseFloor: 0.35,
  installedHoldMs: 900,
} as const;
