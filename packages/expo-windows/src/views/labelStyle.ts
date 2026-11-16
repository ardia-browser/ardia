import type { FadeLabelProps } from "@ardia/shell";
import type { TextStyle } from "react-native";

const FONT_WEIGHT: Record<string, TextStyle["fontWeight"]> = { ultraLight: "100", thin: "200", light: "300", regular: "400", medium: "500", semibold: "600", bold: "700", heavy: "800", black: "900" };
const LABEL_COLOR = { light: "rgba(0,0,0,0.85)", dark: "rgba(255,255,255,0.85)" };

export function labelTextStyle({ fontSize, weight, fontFamily, color, strikethrough }: Pick<FadeLabelProps, "fontSize" | "weight" | "fontFamily" | "color" | "strikethrough">, dark: boolean): TextStyle {
  return {
    fontSize: Math.max(1, typeof fontSize === "number" && Number.isFinite(fontSize) ? fontSize : 13),
    fontWeight: FONT_WEIGHT[typeof weight === "string" ? weight : "regular"] ?? "400",
    fontVariant: ["tabular-nums"],
    ...(fontFamily ? { fontFamily } : null),
    ...(strikethrough === true ? { textDecorationLine: "line-through" } : null),
    color: typeof color === "string" && color.length > 0 ? color : LABEL_COLOR[dark ? "dark" : "light"],
  };
}
