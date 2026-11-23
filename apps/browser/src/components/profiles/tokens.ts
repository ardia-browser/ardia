import { radius } from "../ui/tokens";

export const profileColors = {
  stackRing: { dark: "rgba(0,0,0,0.35)", light: "#FFFFFF" },
  badgeEdge: "rgba(0,0,0,0.12)",
} as const;

export const profileBadge = { nudge: 0.031, initialScale: 0.425, initialTracking: -0.019, emojiScale: 0.55, emojiFitByBadge: { 16: { fontSize: 8.8, shiftX: 0.5 }, 20: { fontSize: 12 }, 64: { fontSize: 35 } } as Partial<Record<number, { fontSize: number; shiftX?: number }>>, emojiInkRise: 0.375, emojiInkShift: 0.02 } as const;

export const SHARE_ROW_HEIGHT = 32;

export const profileSwitcher = {
  height: 41,
  band: 28,
  dotCell: 12,
  dot: 6,
  iconCell: 26,
  icon: 11,
  dotTooltipLift: 18.25,
  dots: { selected: 0.85, hovered: 0.4, idle: 0.2 },
  icons: { selected: 1, hovered: 0.7, idle: 0.42 },
  holdPlate: { dot: 16, icon: 22, get radius() { return radius.control; } },
} as const;
