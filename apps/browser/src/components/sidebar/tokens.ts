import { Easing } from "react-native";
import { useTheme } from "../ui/theme";
import { duration, spring } from "../ui/motion";
import { font, ink, radius, shadow, sidebarFont, sidebarIconSize, sidebarPoints, space, withAlpha, type ShadowLevel } from "../ui/tokens";
import type { GroupColor } from "../../state/browser/types";
import type { Settings } from "../../state/settings/settings";
import { GROUP_COLORS } from "../../state/groups/tokens";
import { contrastRatio, mix, parseColor, toHex } from "../../lib/color";
import { fromOklab, hexColor, oklab } from "../../lib/profileLook";

const DARK = {
  groupFill: "rgba(255,255,255,0.1)",
  groupFillEmphasized: "rgba(255,255,255,0.12)",
  groupHeaderHover: "rgba(255,255,255,0.12)",
  groupStroke: "rgba(255,255,255,0.1)",
  groupTitle: "#FFFFFF",
  multiSelected: "rgba(255,255,255,0.1)",
  multiSelectedStroke: "rgba(255,255,255,0.14)",
  dragBorder: "rgba(255,255,255,0.33)",
  dragSilhouette: "#0F0F14",
  dropMark: "rgba(255,255,255,0.93)",
  edgeGlow: "rgba(255,255,255,0.105)",
  folderDropFill: "rgba(255,255,255,0.08)",
  splitDropFill: "rgba(255,255,255,0.42)",
  badge: "rgba(255,255,255,0.9)",
  newTabLabel: "#FFFFFF8C",
  newTabIcon: "#FFFFFF40",
  liveDotRing: "rgba(0,0,0,0.3)",
  engineMarkPlate: "#2C2C2E",
  selectedRowPillFill: "#141617",
  selectedRowPillStroke: "rgba(255,255,255,0.1)",
  incognitoBadge: "rgba(255,255,255,0.08)",
  tileGlow: "#FFFFFF",
  fieldButtonPlate: "rgba(255,255,255,0.08)",
  quietWash: "rgba(255,255,255,0.073)",
  quietHover: "rgba(255,255,255,0.045)",
  quietPressed: "rgba(255,255,255,0.1)",
  quietTile: "rgba(255,255,255,0.04)",
  quietTileLive: "rgba(255,255,255,0.112)",
  quietActiveText: 0.92,
  quietText: 0.53,
  quietFaintText: 0.24,
};

const LIGHT: typeof DARK = {
  groupFill: "rgba(0,0,0,0.05)",
  groupFillEmphasized: "rgba(0,0,0,0.07)",
  groupHeaderHover: "rgba(255,255,255,0.4)",
  groupStroke: "rgba(0,0,0,0.1)",
  groupTitle: "#000000D9",
  multiSelected: "rgba(0,0,0,0.1)",
  multiSelectedStroke: "rgba(0,0,0,0.08)",
  dragBorder: "rgba(0,0,0,0.28)",
  dragSilhouette: "#FFFFFF",
  dropMark: "rgba(0,0,0,0.8)",
  edgeGlow: "rgba(0,0,0,0.1)",
  folderDropFill: "rgba(0,0,0,0.05)",
  splitDropFill: "rgba(0,0,0,0.08)",
  badge: "rgba(0,0,0,0.75)",
  newTabLabel: "#00000080",
  newTabIcon: "#00000042",
  liveDotRing: "rgba(0,0,0,0.1)",
  engineMarkPlate: "#FFFFFF",
  selectedRowPillFill: "#FFFFFF",
  selectedRowPillStroke: "rgba(0,0,0,0.1)",
  incognitoBadge: "rgba(0,0,0,0.06)",
  tileGlow: "#000000",
  fieldButtonPlate: "rgba(255,255,255,0.75)",
  quietWash: "rgba(0,0,0,0.063)",
  quietHover: "rgba(0,0,0,0.035)",
  quietPressed: "rgba(0,0,0,0.09)",
  quietTile: "rgba(0,0,0,0.035)",
  quietTileLive: "rgba(0,0,0,0.1)",
  quietActiveText: 0.9,
  quietText: 0.45,
  quietFaintText: 0.2,
};

export type SidebarTokens = typeof DARK;

const HIGH_CONTRAST_DARK: SidebarTokens = { ...DARK, groupTitle: "#FFFFFF", newTabLabel: "#FFFFFFD1", newTabIcon: "#FFFFFFB3", badge: "#FFFFFF" };
const HIGH_CONTRAST_LIGHT: SidebarTokens = { ...LIGHT, groupTitle: "#000000", newTabLabel: "#000000D1", newTabIcon: "#000000B3", badge: "#000000" };

export function sidebarTokens(theme: { dark: boolean; highContrastText?: boolean }): SidebarTokens {
  if (theme.highContrastText) return theme.dark ? HIGH_CONTRAST_DARK : HIGH_CONTRAST_LIGHT;
  return theme.dark ? DARK : LIGHT;
}

export function useSidebarTokens(): SidebarTokens {
  return sidebarTokens(useTheme());
}


export const SIDEBAR_SHADOW = {
  dragGhost: { color: ink.black, opacity: { dark: 0.45, light: 0.18 }, radius: 10, offset: [0, 4] },
  card: shadow.card,
  searchTabs: shadow.dialog,
  tabSwitcher: { ...shadow.dialog, opacity: { dark: 0.45, light: 0.45 }, radius: 32, offset: [0, 14] },
} satisfies Record<string, ShadowLevel>;

export const TAB_SWITCHER_SCROLL_ID = "ardia-tab-switcher";

export const TAB_SWITCHER = {
  card: 168,
  shotAspect: 1.6,
  gap: space.xs,
  pad: space.m,
  label: 30,
  labelGap: space.s,
  labelInset: space.xxs,
  cardInset: space.xs,
  windowMargin: 80,
  panelRadius: 18,
  get cardRadius() {
    return radius.panel;
  },
  get previewRadius() {
    return radius.tile;
  },
  ring: { focused: 2, rest: 1 },
  icon: { preview: 30, label: 13, globe: 12 },
  get titleSize() {
    return font.small.fontSize;
  },
} as const;

const TAB_SWITCHER_DARK = {
  fill: "#1C1C1EF2",
  focusFill: "rgba(255,255,255,0.14)",
  restRing: "rgba(255,255,255,0.12)",
  pageFill: "#FFFFFF",
  blankFill: "#3A3A3C",
  onPanel: "#FFFFFFB3",
  onPage: "#000000A6",
  title: "#FFFFFF",
};

const TAB_SWITCHER_LIGHT: typeof TAB_SWITCHER_DARK = {
  fill: "#F2F2F7F2",
  focusFill: "rgba(0,0,0,0.18)",
  restRing: "rgba(0,0,0,0.1)",
  pageFill: "#FFFFFF",
  blankFill: "#D1D1D6",
  onPanel: "#000000A6",
  onPage: "#000000A6",
  title: "#000000D9",
};

export const tabSwitcherColors = (dark: boolean) => (dark ? TAB_SWITCHER_DARK : TAB_SWITCHER_LIGHT);

export const SELECTED_ROW_SHADOW_OFFSET: [number, number] = [0, 0.5];

export const TILE_GLOW = { opacity: { dark: 0.15, light: 0.12 }, radius: 1.5, offset: [0, 0.5] as [number, number] };

export const SIDEBAR_MOTION = { liveFold: duration.long, fold: duration.base, listSlide: 140, listFade: 100, hoverCardFade: 100 } as const;

export const SLEEPING_TITLE_OPACITY = 0.6;

export const SPLIT_DROP = { gap: 14 } as const;

export const SPLIT_PREVIEW = { response: 0.1, damping: 1 } as const;


export const GHOST_TILE_MORPH = { response: 0.1, damping: 1 } as const;

export const GHOST_ROW_POINTER = 0.37;
export const GHOST_OVER_PROFILES = 0.3;
export const GHOST_OPACITY = 0.96;
export const EDGE_GLOW = {
  width: 36,
  inMs: 180,
  outMs: 150,
  fill: [[0, 0], [0.2, 1], [0.8, 1], [1, 0]],
  fade: [[0, 1], [0.15, 0.75], [0.35, 0.42], [0.6, 0.15], [1, 0]],
} as const;

export const TAB_ROW = {
  contentLeft: 9,
  trailing: 6,
  titleGap: 5,
  get titleHeight() {
    return sidebarPoints(18);
  },
  get compactTitleHeight() {
    return sidebarPoints(17);
  },
  closeSlot: 22,
  renameTextOffset: 1,
};

export const ROW_GLYPH = {
  get box() {
    return sidebarIconSize(16);
  },
  get symbol() {
    return sidebarPoints(12);
  },
  get small() {
    return sidebarPoints(11);
  },
  get plus() {
    return sidebarPoints(13);
  },
  get wide() {
    return sidebarPoints(18);
  },
};

export const TILE_RIM = 1;
export const TILE_STATUS = { pip: 8, speaker: 9.5, box: { width: 14, height: 12 }, inset: { x: 5, y: 4 } } as const;

export const AWAY_TITLE = { slashAlpha: 0.45, slashGap: 4, pinnedMaxWidth: "45%" } as const;

export const TABULAR_NUMS: ("tabular-nums")[] = ["tabular-nums"];

export const SIDEBAR_TYPE = {
  get title() {
    return sidebarFont.body.fontSize;
  },
  get compact() {
    return sidebarFont.small.fontSize;
  },
};

export function groupTint(color: GroupColor | null | undefined): string | null {
  return color && color !== "none" ? (GROUP_COLORS[color]?.hex ?? null) : null;
}

export const groupBoxAtRest = (color: GroupColor | null | undefined) => groupTint(color) !== null;

type FolderStyle = Settings["folderStyle"];

const FOLDER_NEUTRAL = { dark: "#FFFFFF", light: "#6E6E73" } as const;

export const FOLDER_OUTLINE_CONTRAST = 3.3;

const FOLDER_INK = {
  light: { outlineStart: 0.62, outlineEnd: 0.2, outlineChroma: 1, pastelChroma: 2, pastelChromaMax: 0.1, face: 0.94, faceChroma: 0.6, faceChromaMax: 0.05, insideTop: 0.3, insideBottom: 0.55 },
  dark: { outlineStart: 0.8, outlineEnd: 0.98, outlineChroma: 0.75, pastelChroma: 0, pastelChromaMax: 0, face: 0.32, faceChroma: 0.5, faceChromaMax: 0.05, insideTop: 0.45, insideBottom: 0.2 },
} as const;

const OUTLINE_STEP = 0.01;

type Lch = { l: number; c: number; h: number };

function lch(color: string): Lch {
  const [l, a, b] = oklab(hexColor(color));
  return { l, c: Math.hypot(a, b), h: Math.atan2(b, a) };
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

function lchHex({ l, c, h }: Lch): string {
  const at = (chroma: number) => fromOklab([l, chroma * Math.cos(h), chroma * Math.sin(h)]);
  let [low, high] = [0, c];
  if (inGamut(at(c))) low = c;
  else
    for (let i = 0; i < 16; i++) {
      const mid = (low + high) / 2;
      if (inGamut(at(mid))) low = mid;
      else high = mid;
    }
  return toHex(at(low).map((v) => Math.min(1, Math.max(0, v)) * 255));
}

const worstContrast = (color: string, backdrops: readonly string[]) => Math.min(...backdrops.map((backdrop) => contrastRatio(color, backdrop)));

type FolderInkSide = keyof typeof FOLDER_INK;

type FolderOutline = { side: FolderInkSide; stroke: string; contrast: number };

const outlineChroma = (tint: Lch, side: FolderInkSide) => {
  const ink = FOLDER_INK[side];
  return Math.max(tint.c * ink.outlineChroma, Math.min(tint.c * ink.pastelChroma, ink.pastelChromaMax));
};

const outlineStart = (tint: Lch, side: FolderInkSide) =>
  side === "dark" ? Math.max(tint.l, FOLDER_INK.dark.outlineStart) : Math.min(tint.l, FOLDER_INK.light.outlineStart);

function folderOutline(tintHex: string, side: FolderInkSide, backdrops: readonly string[]): FolderOutline {
  const ink = FOLDER_INK[side];
  const lightens = side === "dark";
  const tint = lch(tintHex);
  const c = outlineChroma(tint, side);
  const start = outlineStart(tint, side);
  let l = start;
  let stroke = start === tint.l ? toHex(parseColor(tintHex).slice(0, 3)) : lchHex({ l, c, h: tint.h });
  let contrast = backdrops.length ? worstContrast(stroke, backdrops) : Infinity;
  while (contrast < FOLDER_OUTLINE_CONTRAST && (lightens ? l < ink.outlineEnd : l > ink.outlineEnd)) {
    l += lightens ? OUTLINE_STEP : -OUTLINE_STEP;
    stroke = lchHex({ l, c, h: tint.h });
    contrast = worstContrast(stroke, backdrops);
  }
  return { side, stroke, contrast };
}

const FOLDER_FACE_SPLIT = (FOLDER_INK.light.outlineStart + FOLDER_INK.dark.outlineStart) / 2;

const faceSideFor = (l: number): FolderInkSide => (l < FOLDER_FACE_SPLIT ? "light" : "dark");

let greyLightness: { hex: string; l: number }[] | null = null;

function greys() {
  greyLightness ??= Array.from({ length: 256 }, (_, v) => {
    const hex = toHex([v, v, v]);
    return { hex, l: lch(hex).l };
  });
  return greyLightness;
}

function nearestLegibleOutline(tintHex: string, side: FolderInkSide, backdrops: readonly string[]): FolderOutline | null {
  const tint = lch(tintHex);
  const start = outlineStart(tint, side);
  const c = outlineChroma(tint, side);
  for (let k = 1; k * OUTLINE_STEP <= 1; k++) {
    for (const l of [start - k * OUTLINE_STEP, start + k * OUTLINE_STEP]) {
      if (l < 0 || l > 1) continue;
      const stroke = lchHex({ l, c, h: tint.h });
      const contrast = worstContrast(stroke, backdrops);
      if (contrast >= FOLDER_OUTLINE_CONTRAST) return { side: faceSideFor(l), stroke, contrast };
    }
  }
  const byDistance = [...greys()].sort((a, b) => Math.abs(a.l - start) - Math.abs(b.l - start));
  for (const grey of byDistance) {
    const contrast = worstContrast(grey.hex, backdrops);
    if (contrast >= FOLDER_OUTLINE_CONTRAST) return { side: faceSideFor(grey.l), stroke: grey.hex, contrast };
  }
  return null;
}

function legibleFolderOutline(tintHex: string, dark: boolean, backdrops: readonly string[]): FolderOutline {
  const side: FolderInkSide = dark ? "dark" : "light";
  const preferred = folderOutline(tintHex, side, backdrops);
  if (preferred.contrast >= FOLDER_OUTLINE_CONTRAST) return preferred;
  const opposite = folderOutline(tintHex, dark ? "light" : "dark", backdrops);
  if (opposite.contrast >= FOLDER_OUTLINE_CONTRAST) return opposite;
  const nearest = nearestLegibleOutline(tintHex, side, backdrops);
  if (nearest) return nearest;
  return opposite.contrast > preferred.contrast ? opposite : preferred;
}

function neutralFolderPalette(dark: boolean) {
  const tint = FOLDER_NEUTRAL[dark ? "dark" : "light"];
  return dark
    ? { stroke: mix("#FFFFFF", tint, 0.64), face: mix("#211E29", tint, 0.12), insideTop: mix("#211E29", tint, 0.4), insideBottom: mix("#15121E", tint, 0.24) }
    : { stroke: tint, face: mix("#FFFFFF", tint, 0.06), insideTop: mix("#FFFFFF", tint, 0.34), insideBottom: mix("#FFFFFF", tint, 0.64) };
}

export function folderPalette(color: GroupColor | null | undefined, dark: boolean, profileTint: string, style: FolderStyle = "profile", backdrops: readonly string[] = []) {
  const groupHex = groupTint(color);
  if (!groupHex && style === "neutral") return neutralFolderPalette(dark);
  const tintHex = groupHex ?? profileTint;
  const tint = lch(tintHex);
  const { side, stroke } = legibleFolderOutline(tintHex, dark, backdrops);
  const ink = FOLDER_INK[side];
  const face = lchHex({ l: ink.face, c: Math.min(tint.c * ink.faceChroma, ink.faceChromaMax), h: tint.h });
  return { stroke, face, insideTop: mix(face, stroke, ink.insideTop), insideBottom: mix(face, stroke, ink.insideBottom) };
}

export function groupSurface(color: GroupColor | null | undefined, tokens: SidebarTokens): { fill: string; stroke: string } {
  if (color === "none") return { fill: "transparent", stroke: "transparent" };
  const tint = groupTint(color);
  return tint ? { fill: withAlpha(tint, 0.16), stroke: withAlpha(tint, 0.3) } : { fill: tokens.groupFill, stroke: tokens.groupStroke };
}

export { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../../lib/windowLayout";
export const SIDEBAR_RESIZE_HANDLE = { top: 46, width: 8 } as const;
export const SELECTED_ROW_PILL = {
  height: 28,
  gap: 6,
  icon: 16,
  padLeft: 10,
  padRight: 9,
  iconGap: 6,
  arrow: 10,
  enter: { scale: 0.3, rise: 18 },
  exit: { scale: 0.8, drop: 4 },
} as const;
export const SELECTED_ROW_PILL_MOTION = {
  enter: { duration: 140, easing: Easing.out(Easing.quad) },
  exit: { duration: 60, easing: Easing.linear },
} as const;
export const SELECTED_ROW_REVEAL_SETTLE_MS = 400;
export const REVEAL_ROW_MARGIN = space.s;
