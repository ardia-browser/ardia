import { duration } from "../ui/motion";
import { colorRoles, display, font, space, withAlpha } from "../ui/tokens";

const dark = {
  windowFill: "#1E1E1E",
  sidebarDivider: "rgba(0,0,0,0.6)",
  miniWindow: "#2A2A2C",
  miniBar: "rgba(255,255,255,0.22)",
  miniField: "rgba(255,255,255,0.14)",
  miniPage: "rgba(255,255,255,0.08)",
  get warningFill() { return withAlpha(colorRoles.dark.warning, 0.12); },
  dashedBorder: "rgba(255,255,255,0.25)",
  secondaryText: "rgba(255,255,255,0.62)",
  confirmed: colorRoles.dark.success,
  lockedLink: "#6CB4FF",
};

export type SettingsColors = typeof dark;

const light: SettingsColors = {
  windowFill: "#F2F2F2",
  sidebarDivider: "rgba(0,0,0,0.1)",
  miniWindow: "#E9E9EB",
  miniBar: "rgba(0,0,0,0.16)",
  miniField: "rgba(0,0,0,0.08)",
  miniPage: "#FFFFFF",
  get warningFill() { return withAlpha(colorRoles.light.warning, 0.1); },
  dashedBorder: "rgba(0,0,0,0.2)",
  secondaryText: "rgba(0,0,0,0.62)",
  confirmed: "#248A3D",
  lockedLink: "#0052AD",
};

export const settingsColors = { dark, light } as const;

const modeDark = { window: "#2B2226", line: "rgba(255,255,255,0.2)", page: "#1A1618" };
const modeLight: typeof modeDark = { window: "#EDE6EA", line: "rgba(0,0,0,0.12)", page: "#FFFFFF" };

export const modePreview = { dark: modeDark, light: modeLight } as const;

const themePreviewDark = { line: "rgba(255,255,255,0.35)", card: "rgba(18,18,18,0.72)" };
const themePreviewLight: typeof themePreviewDark = { line: "rgba(0,0,0,0.18)", card: "rgba(255,255,255,0.82)" };

export const themePreview = { dark: themePreviewDark, light: themePreviewLight } as const;

const stylePreviewDark = { backdrop: "#4A3A3E", tile: "rgba(255,255,255,0.1)", tileStroke: "rgba(255,255,255,0.14)" };
const stylePreviewLight: typeof stylePreviewDark = { backdrop: "#E6CED2", tile: "rgba(0,0,0,0.05)", tileStroke: "rgba(0,0,0,0.2)" };

export const stylePreview = { dark: stylePreviewDark, light: stylePreviewLight } as const;

export const paneTints = {
  gray: "#8E8E93",
  get blue() { return colorRoles.dark.formAccent; },
  orange: "#D97706",
  indigo: "#5856D6",
  purple: "#AF52DE",
  pink: "#FF2D55",
  teal: "#1F9BB0",
  get ink() { return colorRoles.light.onAccent; },
} as const;

export const settingsInk = {
  onAccentSecondary: "rgba(255,255,255,0.9)",
  knobOutline: "rgba(0,0,0,0.25)",
  thumbBorder: "rgba(0,0,0,0.2)",
  get customSwatch() { return paneTints.gray; },
} as const;

export const settingsType = {
  get extensionTitle() { return font.large; },
  get lead() { return font.small; },
  get code() { return display.code; },
} as const;

export const settingsReveal = { inset: 12, margin: 16, layoutFrames: 10, measureDeadlineMs: 300, mountDeadlineMs: 10000, get headerGap() { return space.xxl; } } as const;

export const settingsMotion = {
  searchFlashIn: duration.fast,
  searchFlashHold: 900,
  searchFlashOut: duration.long,
  profileRowSettle: duration.base,
} as const;

export type MiniWindowGeometry = {
  scale: number;
  pad: number;
  gap: number;
  side: number | `${number}%`;
  sideTop: number;
  sideFieldTop: number;
  bar: number;
  barGap: number;
  tab: number;
  tabsLeft: number;
  sideField: number;
  toolbar: number;
  toolbarField: number;
  nav: { width: number; height: number };
};

export const miniWindow: Record<"s" | "m" | "l", MiniWindowGeometry> = {
  s: { scale: 0.4, pad: space.s, gap: space.m, side: 36, sideTop: space.xs, sideFieldTop: space.xs, bar: 4, barGap: space.xs, tab: 7, tabsLeft: space.l, sideField: 8, toolbar: 13, toolbarField: 7, nav: { width: 14, height: 4 } },
  m: { scale: 0.4, pad: space.s, gap: space.xs, side: "26%", sideTop: space.m, sideFieldTop: space.xs, bar: 5, barGap: space.xs, tab: 7, tabsLeft: space.l, sideField: 8, toolbar: 13, toolbarField: 7, nav: { width: 14, height: 4 } },
  l: { scale: 0.5, pad: space.m, gap: space.xs, side: "26%", sideTop: space.ml, sideFieldTop: space.xs, bar: 7, barGap: space.xs, tab: 10, tabsLeft: space.xxxl, sideField: 10, toolbar: 16, toolbarField: 9, nav: { width: 18, height: 5 } },
};

export const paneTile = { size: 20, radius: 5, symbol: 11 } as const;

export const paneGlyph: Record<string, { size: number; weight: "regular" | "medium" | "semibold" | "bold" }> = {
  "gearshape.fill": { size: 13, weight: "medium" },
  "person.2.fill": { size: 11.5, weight: "semibold" },
  "square.on.square.fill": { size: 12.5, weight: "semibold" },
  "circle.lefthalf.filled": { size: 13, weight: "semibold" },
  "wand.and.rays": { size: 13, weight: "bold" },
  "puzzlepiece.fill": { size: 11, weight: "medium" },
  "keyboard.fill": { size: 12, weight: "semibold" },
  "slider.horizontal.3": { size: 14, weight: "bold" },
};

export const settingsLayout = { emptyTop: 40, sidebarWidth: 214, paneMaxWidth: 600, paneBottom: 40 } as const;

export const pictureChoice = { m: 84, l: 104, icon: 70, iconWidth: 72 } as const;

export const selectableCard = { selectedBorder: 2, selectedAlpha: "26" } as const;
