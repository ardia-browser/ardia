import type { LibrarySection } from "../../state/library/library";
import { layout } from "../ui/theme";
import { radius, sidebarLineHeight, space, withAlpha, type ColorRoles } from "../ui/tokens";
import { buttonMotion, duration } from "../ui/motion";

const RAIL_WIDTH = 96;
const PANEL_WIDTH = 264;
const PANEL_MIN = 240;
const CONTENT_MIN = 420;
const PANEL_PAD = space.m;
const GRID_GAP = space.m;
const CARD_WIDTH = 180;
const CARD_GAP = space.xl;
const CARD_PAD = space.xl;
const CARD_ADD = 26;

export const LIBRARY = {
  rail: {
    width: RAIL_WIDTH,
    inset: 7,
    item: 68,
    gap: 18,
    glyph: 19,
    glyphBox: 24,
    labelGap: space.xs,
    backBottom: space.m,
    backSize: "toolbar" as const,
  },
  footer: {
    glyph: 14,
    finishedHold: 2400,
    symbols: { idle: "archivebox.fill", open: "archivebox.fill", downloading: "arrow.down.circle", finished: "checkmark.circle", blocked: "exclamationmark.triangle" },
    box: { left: -8.5, top: -8.5, width: 17, split: -3.125 },
    lid: { lift: -2.5, shift: -0.5, tilt: -10 },
  },
  panel: { width: PANEL_WIDTH, min: PANEL_MIN, pad: PANEL_PAD, headerGap: space.s, searchBelow: space.m },
  search: {
    get height() {
      return layout.rowHeight;
    },
    get radius() {
      return radius.chrome;
    },
    glyph: 12,
    glyphBox: 16,
    listGlyphLift: 0.5,
    gridGlyphLift: 0.5,
  },
  filter: { height: 26, inset: 2, gap: 0 },
  grid: {
    gap: GRID_GAP,
    columns: 2,
    tileInset: space.s,
    thumbRadius: radius.control,
    audioGlyph: 34,
    fileIcon: 64,
    thumbScale: 2,
    get radius() {
      return radius.pinned;
    },
  },
  card: { cornerInset: space.xs, textAbove: space.s, textInset: space.xxs, faceShare: 0.7, favicon: 32, fileIcon: 48, progressInset: space.s },
  list: {
    inset: space.s,
    row: 46,
    header: 30,
    headerBelow: space.xs,
    rowPad: 9,
    iconGap: space.m,
    favicon: 16,
    fileIcon: 22,
    thumbRadius: 4,
    endPad: space.l,
    lead: space.s,
    progressHeight: 3,
    progressMin: 0.03,
    missingOpacity: 0.45,
    get radius() {
      return radius.chrome;
    },
  },
  cards: {
    width: CARD_WIDTH,
    gap: CARD_GAP,
    pad: CARD_PAD,
    badge: 28,
    minHeight: 220,
    selectedBorder: 2,
    pressScale: buttonMotion.controlPressScale,
    handleGlyph: 11,
    add: CARD_ADD,
    addRing: 1,
    renameHeight: 24,
    handleBox: 22,
    dragStart: 4,
    dragSlack: 8,
    liftScale: 1.02,
    settle: duration.base,
  },
  profileBadge: { row: 11, card: 14, filter: 14, ring: 1.5, rowOverhang: 4, cardInset: space.s },
  empty: { lift: 40, actionGap: space.m },
  overscanShare: 0.5,
  firstFrameOverscanShare: 0.125,
  scrollEdge: { below: 16, fadeMs: 160, radius: 8, solidShare: 0.2, fadeReach: 1.6 },
} as const;

export const LIBRARY_SYMBOLS: Record<LibrarySection, string> = {
  media: "photo.on.rectangle",
  downloads: "arrow.down.circle",
  profiles: "square.stack",
  history: "clock.arrow.circlepath",
};

export const LIBRARY_TITLES: Record<LibrarySection, string> = {
  media: "Media",
  downloads: "Downloads",
  profiles: "Profiles",
  history: "History",
};

export const LIBRARY_EMPTY: Record<LibrarySection, string> = {
  media: "No Media",
  downloads: "No Downloads",
  profiles: "No Profiles",
  history: "No History",
};

export const NO_RESULTS = "No Results";

export const LIBRARY_SEARCH: Record<LibrarySection, string> = {
  media: "Search Media",
  downloads: "Search Downloads",
  profiles: "Search Profiles",
  history: "Search History",
};

const CARD_TINT = { dark: { rest: 0.22, hover: 0.3, pressed: 0.38 }, light: { rest: 0.24, hover: 0.32, pressed: 0.4 } } as const;

export function cardTint(theme: Pick<ColorRoles, "dark">, accent: string, state: "rest" | "hover" | "pressed") {
  return withAlpha(accent, CARD_TINT[theme.dark ? "dark" : "light"][state]);
}

export function profilesPanelWidth(profileCount: number) {
  const count = Math.max(1, profileCount);
  return count * CARD_WIDTH + count * CARD_GAP + CARD_ADD + 2 * CARD_PAD;
}

export function gridTileSize(panelWidth: number) {
  const columns = LIBRARY.grid.columns;
  return Math.floor((panelWidth - 2 * PANEL_PAD - (columns - 1) * GRID_GAP) / columns);
}

export const cardFaceHeight = (tile: number) => Math.round(tile * LIBRARY.card.faceShare);

export const textCardHeight = (tile: number) => cardFaceHeight(tile) + LIBRARY.card.textAbove + sidebarLineHeight.body + sidebarLineHeight.caption;

export type LibraryLayout = { rail: number; panel: number };

export function libraryLayout(windowWidth: number, section: LibrarySection, profileCount: number, sidebarWidth = 0): LibraryLayout {
  const rail = RAIL_WIDTH;
  const room = windowWidth - rail - CONTENT_MIN;
  const wanted = section === "profiles" ? Math.max(PANEL_WIDTH, profilesPanelWidth(profileCount)) : PANEL_WIDTH;
  return { rail, panel: Math.max(PANEL_MIN, sidebarWidth - rail, Math.min(wanted, room)) };
}
