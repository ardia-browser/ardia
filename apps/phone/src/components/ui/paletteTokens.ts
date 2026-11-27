export type ProfileColor = "plum" | "blue" | "purple" | "pink" | "red" | "orange" | "yellow" | "green" | "neutral";

export type ProfileColorSpec = { name: string; swatch: string; tint?: string; action?: string };

export const PROFILE_COLORS: Record<ProfileColor, ProfileColorSpec> = {
  plum: { name: "Plum", swatch: "#C07A98", tint: "#B25B6B", action: "#DD899B" },
  blue: { name: "Blue", swatch: "#4691C3" },
  purple: { name: "Purple", swatch: "#7873AF" },
  pink: { name: "Pink", swatch: "#D37B8B" },
  red: { name: "Red", swatch: "#C1575C" },
  orange: { name: "Orange", swatch: "#D87249" },
  yellow: { name: "Yellow", swatch: "#E3AC38" },
  green: { name: "Green", swatch: "#3EB489" },
  neutral: { name: "Neutral", swatch: "#8E8E93" },
};

export const neutralFills = {
  light: { appSurface: "#FFFFFF", groupedBackground: "#F2F2F7", groupedCell: "#FFFFFF" },
  dark: { appSurface: "#000000", groupedBackground: "#1C1C1E", groupedCell: "#2C2C2E" },
} as const;

export const neutralAccent = {
  light: { fill: "#1C1C1E", ink: "#1C1C1E", on: "#FFFFFF" },
  dark: { fill: "#F2F2F7", ink: "#F2F2F7", on: "#000000" },
} as const;

export const accentInkBase = { onFill: "#FFFFFF", onLightFill: "#000000", darken: "#000000", lighten: "#FFFFFF" } as const;

export const emphasisTone = { darkSaturation: 0.62, lightSaturation: 0.48, darkLightness: 0.72, lightLightness: 0.44 } as const;

export const accentWashAlpha = { neutral: 0.08, light: 0.12, dark: 0.22 } as const;

export const contrastMinimum = { text: 4.5, largeText: 3, glyph: 3, whiteOnDeepenedFill: 3.3 } as const;

export const accentSearchStep = 0.02;
