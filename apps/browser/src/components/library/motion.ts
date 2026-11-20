import { Easing } from "react-native";
import { curve, spring, springSpec } from "../ui/motion";
import { layout } from "../ui/theme";
import { radius, space } from "../ui/tokens";
import { TAB_ROW } from "../sidebar/tokens";

export const LIBRARY_MOTION = {
  spring: spring({ response: 0.25, damping: 1 }),
  filter: spring(springSpec.snappy),
  rail: spring(springSpec.snappy),
  content: { duration: 120, easing: Easing.bezier(0.23, 1, 0.32, 1) },
  page: { duration: 200, easing: Easing.bezier(0.23, 1, 0.32, 1), shift: 14, prewarm: 400, prewarmGap: 250, viewPrewarm: 900 },
  slide: { duration: 200, easing: Easing.bezier(0.23, 1, 0.32, 1), maxRows: 3, maxShift: 400 },
  edge: { fade: 140 },
  morph: { sidebarGoneBy: 0.35, libraryFrom: 0.25, librarySolidBy: 0.7, drift: 12 },
  lid: { open: spring({ response: 0.34, damping: 0.62 }), close: spring({ response: 0.24, damping: 1 }) },
  swap: {
    scale: 0.5,
    out: { duration: 160, easing: curve.enter },
    in: { stiffness: 380, damping: 26, mass: 1 },
    fade: { duration: 150, easing: curve.enter },
  },
  hover: {
    count: 4,
    delay: 500,
    leaveGrace: 160,
    thumb: 40,
    thumbRadius: 5,
    row: 56,
    gap: 12,
    inset: space.xxs,
    pad: space.xs,
    get rowInset() {
      return layout.sidebarInset - space.xxs;
    },
    get rowPad() {
      return TAB_ROW.contentLeft;
    },
    lift: space.xs,
    labelAlpha: 0.85,
    nameHeadMin: 32,
    fitSlack: 2,
    measureRoom: 2000,
    lineGap: 0,
    progressGap: 3,
    from: 0.94,
    get radius() {
      return radius.panel;
    },
    get rowRadius() {
      return radius.tile;
    },
    show: { duration: 220, easing: Easing.bezier(0.23, 1, 0.32, 1) },
    hide: { duration: 140, easing: curve.enter },
  },
} as const;
