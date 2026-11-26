const SIDES = ["Top", "Right", "Bottom", "Left"] as const;
const CORNERS = ["TopLeft", "TopRight", "BottomRight", "BottomLeft"] as const;
const LOGICAL_CORNERS = ["borderTopStartRadius", "borderTopEndRadius", "borderBottomStartRadius", "borderBottomEndRadius"] as const;
const BORDER_BOX_CLIP = { overflow: "clip", overflowClipMargin: "border-box" } as const;
const CLEAR_BORDER = { borderColor: "transparent", borderTopColor: "transparent", borderRightColor: "transparent", borderBottomColor: "transparent", borderLeftColor: "transparent" } as const;
const ABOVE_CONTENT = 2147483647;

type ClipStyle = Record<string, unknown>;
export type BorderRing = Record<string, string | number>;

const widthOf = (style: ClipStyle, side: string) => {
  const width = style[`border${side}Width`] ?? style.borderWidth ?? 0;
  return typeof width === "number" && Number.isFinite(width) ? width : 0;
};

const colorOf = (style: ClipStyle, side: string) => style[`border${side}Color`] ?? style.borderColor;

const radiusOf = (style: ClipStyle, corner: string) => {
  const radius = style[`border${corner}Radius`] ?? style.borderRadius ?? 0;
  return typeof radius === "number" || typeof radius === "string" ? radius : null;
};

export function borderBoxClip(style: ClipStyle | null | undefined): { style: ClipStyle; ring: BorderRing | null } | null {
  if (style?.overflow !== "hidden") return null;
  const widths = SIDES.map((side) => widthOf(style, side));
  if (!widths.some((width) => width > 0)) return null;
  const colors = SIDES.map((side) => colorOf(style, side));
  const radii = CORNERS.map((corner) => radiusOf(style, corner));
  const [width = 0] = widths;
  const [color] = colors;
  const lineStyle = style.borderStyle ?? "solid";
  const ringable =
    widths.every((each) => each === width) &&
    typeof color === "string" &&
    colors.every((each) => each === color) &&
    typeof lineStyle === "string" &&
    radii.every((radius) => radius !== null) &&
    LOGICAL_CORNERS.every((key) => style[key] === undefined);
  if (!ringable) return { style: BORDER_BOX_CLIP, ring: null };
  const ring: BorderRing = {
    position: "absolute",
    top: -width,
    right: -width,
    bottom: -width,
    left: -width,
    boxSizing: "border-box",
    borderStyle: lineStyle,
    borderWidth: width,
    borderColor: color,
    pointerEvents: "none",
    zIndex: ABOVE_CONTENT,
  };
  CORNERS.forEach((corner, i) => (ring[`border${corner}Radius`] = radii[i]!));
  return { style: { ...BORDER_BOX_CLIP, ...CLEAR_BORDER, isolation: "isolate" }, ring };
}
