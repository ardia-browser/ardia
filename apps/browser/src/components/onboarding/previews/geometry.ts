import { StyleSheet, type ViewStyle } from "react-native";
import { CARD_INSET } from "../../../lib/windowLayout";
import { space } from "../../ui/tokens";

export type Geo = { s: number; W: number; H: number };
export type Rect = { x: number; y: number; w: number; h: number };

const DESIGN = { width: 860, height: 600 } as const;

export function geo(width: number, height: number): Geo {
  const s = Math.min(width / DESIGN.width, height / DESIGN.height);
  return { s, W: width / s, H: height / s };
}

export const SIDEBAR_W = 190;
export const ROW = { x: 6, w: 178, h: 34, pitch: 37, top: 62, topWithField: 94 } as const;
export const FIELD: Rect = { x: 6, y: 46, w: 178, h: 34 };
export const TOOLBAR_H = 41;
export const CRUMB_X = 153;
export const CRUMB_TRAILING = 20;
export const FIELD_CRUMB: Rect = { x: 12, y: 8, w: FIELD.w - 24, h: 18 };
export const STRIP_H = 42;
export const CHIP = { x: 76, w: 173, gap: space.xs, top: 5, h: 32 } as const;
export const CARD = CARD_INSET;
const SIDE_CARD_X = SIDEBAR_W + CARD_INSET - ROW.x;
export const LIGHTS_Y = { toolbar: CARD_INSET + 21, field: 24, strip: 20.75 } as const;
export const TOOLBAR_ICONS = [21, 56, 92, 127] as const;
export const SIDEBAR_ICONS = [98, 133, 168] as const;
export const rowY = (i: number, top: number = ROW.top) => top + i * ROW.pitch;
export const CHIP_STEP = CHIP.w + CHIP.gap;
export const chipX = (i: number) => CHIP.x + i * CHIP_STEP;
export const restRowCount = (g: Geo) => Math.max(1, Math.min(6, Math.floor((g.H - ROW.topWithField - ROW.pitch - 20) / ROW.pitch)));
export const restChipCount = (g: Geo) => Math.max(1, Math.min(4, Math.floor((g.W - CHIP.x - 40) / CHIP_STEP)));
export const restCard = (g: Geo, top: boolean, frame: number): Rect => {
  if (top) return { x: frame, y: STRIP_H, w: g.W - 2 * frame, h: g.H - STRIP_H - frame };
  const x = SIDEBAR_W + Math.max(0, frame - ROW.x);
  return { x, y: frame, w: g.W - x - frame, h: g.H - 2 * frame };
};

export const sideCard = (g: Geo): Rect => ({ x: SIDE_CARD_X, y: CARD, w: g.W - SIDE_CARD_X - CARD, h: g.H - 2 * CARD });
export const topCard = (g: Geo): Rect => ({ x: CARD, y: STRIP_H, w: g.W - 2 * CARD, h: g.H - STRIP_H - CARD });

export const at = (g: Geo, x: number, y: number, w: number, h: number): ViewStyle => ({ position: "absolute", left: x * g.s, top: y * g.s, width: w * g.s, height: h * g.s });
export const atRect = (g: Geo, r: Rect) => at(g, r.x, r.y, r.w, r.h);
export const hairline = StyleSheet.hairlineWidth;
export const fill = StyleSheet.absoluteFill;
