import type { ViewStyle } from "react-native";

export type Flat = ViewStyle & Record<string, unknown>;

export const FILL_Z_INDEX = -2147483647;

type Corner = { key: "borderTopLeftRadius" | "borderTopRightRadius" | "borderBottomLeftRadius" | "borderBottomRightRadius"; names: string[]; vertical: "top" | "bottom"; horizontal: "left" | "right" };

const CORNERS: Corner[] = [
  { key: "borderTopLeftRadius", names: ["borderTopLeftRadius", "borderTopStartRadius", "borderStartStartRadius"], vertical: "top", horizontal: "left" },
  { key: "borderTopRightRadius", names: ["borderTopRightRadius", "borderTopEndRadius", "borderStartEndRadius"], vertical: "top", horizontal: "right" },
  { key: "borderBottomLeftRadius", names: ["borderBottomLeftRadius", "borderBottomStartRadius", "borderEndStartRadius"], vertical: "bottom", horizontal: "left" },
  { key: "borderBottomRightRadius", names: ["borderBottomRightRadius", "borderBottomEndRadius", "borderEndEndRadius"], vertical: "bottom", horizontal: "right" },
];

const width = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export function backgroundFill(flat: Flat): ViewStyle | null {
  const color = flat.backgroundColor;
  if (color == null || color === "transparent") return null;
  const all = width(flat.borderWidth, 0);
  const sides = {
    top: width(flat.borderTopWidth, all),
    bottom: width(flat.borderBottomWidth, all),
    left: width(flat.borderLeftWidth, width(flat.borderStartWidth, all)),
    right: width(flat.borderRightWidth, width(flat.borderEndWidth, all)),
  };
  const fill: Flat = { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: FILL_Z_INDEX, backgroundColor: color };
  for (const corner of CORNERS) {
    const outer = corner.names.map((name) => flat[name]).find((radius) => radius != null) ?? flat.borderRadius;
    if (typeof outer === "number") fill[corner.key] = Math.max(0, outer - Math.max(sides[corner.vertical], sides[corner.horizontal]));
    else if (typeof outer === "string") fill[corner.key] = outer;
  }
  if (flat.borderCurve) fill.borderCurve = flat.borderCurve;
  return fill;
}
