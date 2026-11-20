import type { ViewStyle } from "react-native";

export type Flat = ViewStyle & Record<string, unknown>;

export type Backed = { fill: Flat; own: Flat };

export type ColorDraws = (color: unknown) => boolean;

export const FILL_Z_INDEX = -2147483648;

const CLEAR = "transparent";

export const drawsByName: ColorDraws = (color) => color != null && color !== CLEAR;

export const processedColorDraws = (processed: unknown) => processed != null && (typeof processed !== "number" || processed >>> 24 !== 0);

const isBorderKey = (key: string) => key.startsWith("border");

const isBorderColor = (key: string) => isBorderKey(key) && key.endsWith("Color");

const isBorderShape = (key: string) => isBorderKey(key) && (key.endsWith("Radius") || key === "borderCurve" || key === "borderStyle");

const width = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function borderWidths(flat: Flat) {
  const all = width(flat.borderWidth, 0);
  return {
    top: width(flat.borderTopWidth, all),
    bottom: width(flat.borderBottomWidth, all),
    left: width(flat.borderStartWidth, width(flat.borderLeftWidth, all)),
    right: width(flat.borderEndWidth, width(flat.borderRightWidth, all)),
  };
}

const outward = (side: number) => -side || 0;

function withoutPaint(style: Flat, clearBorder: boolean): Flat {
  const own: Flat = {};
  for (const key of Object.keys(style)) if (key !== "backgroundColor" && !isBorderColor(key)) own[key] = style[key];
  if (clearBorder) own.borderColor = CLEAR;
  return own;
}

export function backedStyles(flat: Flat | undefined, draws: ColorDraws = drawsByName): Backed | null {
  if (!flat || !draws(flat.backgroundColor)) return null;
  const sides = borderWidths(flat);
  const fill: Flat = { position: "absolute", top: outward(sides.top), bottom: outward(sides.bottom), left: outward(sides.left), right: outward(sides.right), zIndex: FILL_Z_INDEX, backgroundColor: flat.backgroundColor };
  for (const key of Object.keys(flat)) if (isBorderKey(key)) fill[key] = flat[key];
  const bordered = Object.values(sides).some((side) => side > 0);
  return { fill, own: withoutPaint(flat, bordered) };
}

const isPaint = (key: string) => key === "backgroundColor" || isBorderColor(key) || isBorderShape(key);

export function nativePaint(style: Flat | undefined): Backed | null {
  if (!style) return null;
  const sent: Flat = {};
  for (const key of Object.keys(style)) sent[key] = style[key] === undefined && isPaint(key) ? null : style[key];
  const fill: Flat = {};
  for (const key of Object.keys(sent)) if (isPaint(key)) fill[key] = sent[key];
  if (!Object.keys(fill).length) return null;
  return { fill, own: withoutPaint(sent, false) };
}
