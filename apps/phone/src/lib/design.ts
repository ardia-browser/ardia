export type Design = "original" | "redesigned" | "material";

export const DESIGNS: readonly Design[] = ["original", "redesigned"];

export const designFor = (os: string, labRedesign = false, materialYou = false): Design => {
  if (os === "android" && materialYou) return "material";
  return os === "ios" || os === "android" || labRedesign ? "redesigned" : "original";
};
