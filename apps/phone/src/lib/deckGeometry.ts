import type { Design } from "./design";

export type DeckGeometry = {
  width: number;
  height: number;
  safeTop: number;
  safeBottom: number;
  safeSide: number;
  cardWidth: number;
  cardHeight: number;
  focusLeading: number;
  spacing: number;
  leftReach: number;
  cardCenterY: number;
  barCenterY: number;
  tabButtonX: number;
  screenCorner: number;
};

export const DECK = {
  cardWidthRatio: 306 / 440,
  focusLeadingRatio: 66 / 440,
  leftPeek: 70,
  stepRatio: 218 / 440,
  headerHeight: 20,
  barReserve: 58,
  topReserve: 12,
  launcherStartWidth: 22,
  launcherStartRadius: 4,
  cardRadius: 13,
  displayCornerRadius: 55,
} as const;

export const DECK_REDESIGN = { barReserve: 67, chromeGap: 21, minSafeBottom: 20, barAboveSafeBottom: 11 } as const;

export const BUTTON_NAVIGATION_INSET = 32;
const BAR_HALF_HEIGHT = 22;
const BAR_GAP = 6;
const REDESIGNED_BAR_HALF_HEIGHT = 24;

export function deckBarCenterFromBottom(navigationInset: number, os: string = "android"): number {
  if (os === "android" && navigationInset > BUTTON_NAVIGATION_INSET) return navigationInset + BAR_HALF_HEIGHT + BAR_GAP;
  return Math.max(navigationInset, 20) + BAR_GAP;
}

export function redesignedBarCenterFromBottom(navigationInset: number, os: string = "android"): number {
  const iPhonePlacement = Math.max(navigationInset, DECK_REDESIGN.minSafeBottom) + DECK_REDESIGN.barAboveSafeBottom;
  if (os === "android" && navigationInset > BUTTON_NAVIGATION_INSET) return Math.max(iPhonePlacement, navigationInset + BAR_GAP + REDESIGNED_BAR_HALF_HEIGHT);
  return iPhonePlacement;
}

function reach(peek: number, spacing: number): number {
  const clamped = Math.max(peek, 8);
  let value = clamped;
  for (let i = 0; i < 6; i++) value = clamped / (1 - Math.exp(-spacing / value));
  return value;
}

export function deckGeometry(width: number, height: number, safeTop: number, safeBottom: number, safeSide = 0, os: string = "android", design: Design = "original", chromeHeight = 0, screenCorner: number = DECK.displayCornerRadius): DeckGeometry {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  const redesigned = design === "redesigned";
  const bandTop = redesigned ? safeTop + chromeHeight + DECK_REDESIGN.chromeGap + DECK.headerHeight : safeTop + DECK.topReserve + DECK.headerHeight;
  const barCenter = redesigned ? redesignedBarCenterFromBottom(safeBottom, os) : deckBarCenterFromBottom(safeBottom, os);
  const bandBottom = redesigned ? h - barCenter + DECK_REDESIGN.barAboveSafeBottom - DECK_REDESIGN.barReserve + 24 : h - barCenter + BAR_GAP - DECK.barReserve + 24;
  const band = Math.max(bandBottom - bandTop, 120);
  const aspect = h / w;
  const cardWidth = Math.min(w * DECK.cardWidthRatio, band / aspect);
  const focusLeading = w * DECK.focusLeadingRatio;
  const spacing = Math.min(cardWidth, w * DECK.stepRatio);
  return {
    width: w,
    height: h,
    safeTop,
    safeBottom,
    safeSide,
    cardWidth,
    cardHeight: cardWidth * aspect,
    focusLeading,
    spacing,
    leftReach: reach(Math.min(DECK.leftPeek, focusLeading - 6), spacing),
    cardCenterY: bandTop + band / 2,
    barCenterY: h - barCenter,
    tabButtonX: safeSide + 16 + 17.5,
    screenCorner,
  };
}

export type DeckMorph = { dx: number; dy: number; scale: number; originX: number; originY: number };

export const NO_DECK_MORPH: DeckMorph = { dx: 0, dy: 0, scale: 1, originX: 0, originY: 0 };

export function deckMorphFrom(was: DeckGeometry, now: DeckGeometry): DeckMorph {
  const originX = now.focusLeading + now.cardWidth / 2;
  return { dx: was.focusLeading + was.cardWidth / 2 - originX, dy: was.cardCenterY - now.cardCenterY, scale: was.cardWidth / Math.max(now.cardWidth, 1), originX, originY: now.cardCenterY };
}

export function deckLeading(g: DeckGeometry, relative: number): number {
  "worklet";
  if (relative >= 0) return g.focusLeading + g.spacing * relative;
  return g.focusLeading - g.leftReach * (1 - Math.exp((relative * g.spacing) / g.leftReach));
}

export function deckVisibleWidth(g: DeckGeometry, relative: number, isLast: boolean): number {
  "worklet";
  if (isLast) return g.cardWidth;
  return Math.min(g.cardWidth, Math.max(0, deckLeading(g, relative + 1) - deckLeading(g, relative)));
}

export function swiftRound(value: number): number {
  "worklet";
  const magnitude = Math.floor(Math.abs(value) + 0.5);
  return value < 0 ? -magnitude : magnitude;
}

export function deckRubberBand(scroll: number, count: number): number {
  "worklet";
  const upper = Math.max(count - 1, 0);
  if (scroll < 0) return -Math.pow(-scroll, 0.7) * 0.35;
  if (scroll > upper) return upper + Math.pow(scroll - upper, 0.7) * 0.35;
  return scroll;
}

export function deckSettleTarget(g: DeckGeometry, scroll: number, velocity: number, count: number): number {
  "worklet";
  if (count <= 0) return 0;
  const projected = scroll - (velocity / g.spacing) * 0.22;
  return Math.min(Math.max(swiftRound(projected), 0), count - 1);
}

export function deckShouldClose(translation: number, velocity: number, cardHeight: number): boolean {
  "worklet";
  if (translation >= 0) return false;
  if (velocity < -500) return true;
  return -translation > cardHeight / 3 && velocity < 250;
}

export function deckCardAt(g: DeckGeometry, count: number, scroll: number, x: number, y: number): number {
  "worklet";
  if (count <= 0) return -1;
  const half = g.cardHeight / 2;
  if (y < g.cardCenterY - half || y > g.cardCenterY + half) return -1;
  for (let index = count - 1; index >= 0; index--) {
    const leading = deckLeading(g, index - scroll);
    if (x >= leading && x <= leading + g.cardWidth) return index;
  }
  return -1;
}

export function focusedIndex(scroll: number, count: number): number {
  "worklet";
  return Math.min(Math.max(swiftRound(scroll), 0), Math.max(count - 1, 0));
}

export const initialDeckScroll = (count: number) => Math.max(0, count - 2);

export const openingDeckScroll = (index: number, count: number) => (index < count - 1 ? index : Math.max(0, Math.min(index - 1, count - 1)));

export const scrollAfterRemoving = (removed: number, scroll: number, remaining: number) => {
  if (remaining <= 0) return 0;
  const shifted = removed < scroll ? scroll - 1 : scroll;
  return Math.min(Math.max(shifted, 0), remaining - 1);
};

export type DeckSlots = Readonly<Record<string, number>>;

export function deckSlot(id: string, index: number, from: DeckSlots, shift: number, gap: number): number {
  "worklet";
  const was = from[id];
  if (was === undefined) return index;
  const start = was + shift;
  return start + (index - start) * gap;
}

export function deckSlotsNow(ids: readonly string[], from: DeckSlots, shift: number, gap: number): DeckSlots {
  "worklet";
  const now: Record<string, number> = {};
  for (let i = 0; i < ids.length; i++) now[ids[i]!] = deckSlot(ids[i]!, i, from, shift, gap);
  return now;
}

export function scrollAfterClosing(position: number, remaining: number, onlyTail: boolean): number {
  return onlyTail ? Math.min(position, initialDeckScroll(remaining)) : position;
}

export const lerp = (from: number, to: number, t: number) => {
  "worklet";
  return from + (to - from) * t;
};

export const DECK_HEADER = { titleHidden: 52, titleShown: 84, iconFade: 12, inset: 8, edge: 16, maxFontScale: 1.35, trailingFade: 14 } as const;

export function deckHeaderPlacement(cardLeft: number, visible: number): { available: number; left: number } {
  "worklet";
  const width = Math.max(visible, 0);
  const available = Math.max(width - DECK_HEADER.inset, 0);
  const centerX = Math.max(cardLeft + width / 2, DECK_HEADER.edge);
  return { available, left: centerX - available / 2 };
}

export function deckHeaderIconReveal(available: number, icon: number): number {
  "worklet";
  return Math.min(Math.max((available - icon) / DECK_HEADER.iconFade, 0), 1);
}

export function deckHeaderLeading(available: number, icon: number, spacing: number, title: number, reveal: number): number {
  "worklet";
  return Math.max(0, (available - (icon + (spacing + title) * reveal)) / 2);
}

export function titleReveal(width: number): number {
  "worklet";
  return Math.min(Math.max((width - DECK_HEADER.titleHidden) / (DECK_HEADER.titleShown - DECK_HEADER.titleHidden), 0), 1);
}

export type DeckDrag = "lift" | "scroll";

export const DECK_TAP_SLOP = 10;

export function deckIsTap(dx: number, dy: number): boolean {
  "worklet";
  return Math.hypot(dx, dy) < DECK_TAP_SLOP;
}

export function deckDragKind(card: number, dx: number, dy: number): DeckDrag {
  "worklet";
  return card >= 0 && Math.abs(dy) > Math.abs(dx) && dy < 0 ? "lift" : "scroll";
}

export function deckLift(dy: number): number {
  "worklet";
  return dy < 0 ? dy : dy * 0.12;
}

export function deckScrollDuringDrag(g: DeckGeometry, start: number, dx: number, count: number): number {
  "worklet";
  return deckRubberBand(start - dx / g.spacing, count);
}

export function deckSettleVelocity(g: DeckGeometry, scroll: number, target: number, velocityX: number): number {
  "worklet";
  const distance = target - scroll;
  if (Math.abs(distance) <= 0.001) return 0;
  return Math.min(Math.max(-velocityX / g.spacing / distance, -30), 30) * distance;
}

export const archiveCardEdgeY = (g: DeckGeometry, aboveBarCenter: number) => g.barCenterY - aboveBarCenter;

export function deckScrollActionTarget(focused: number, count: number, direction: "forward" | "backward"): number | null {
  const target = focused + (direction === "forward" ? 1 : -1);
  return target >= 0 && target < count ? target : null;
}

export function deckStatusStrip(g: DeckGeometry, scaleProgress: number, pageTop: number = g.safeTop): number {
  "worklet";
  return pageTop * (g.cardWidth / Math.max(g.width, 1)) * (1 - Math.min(Math.max(scaleProgress, 0), 1));
}

export function deckBarBand(g: DeckGeometry, barHeight: number, scaleProgress: number): { height: number; grown: number } {
  "worklet";
  return { height: barHeight * (g.cardWidth / Math.max(g.width, 1)), grown: 1 - Math.min(Math.max(scaleProgress, 0), 1) };
}

export function mergeDeckOrder(shown: readonly string[], live: readonly string[]): string[] {
  const alive = new Set(live);
  const next = shown.filter((id) => alive.has(id));
  const known = new Set(next);
  for (let i = 0; i < live.length; i++) {
    const id = live[i]!;
    if (known.has(id)) continue;
    let at = next.length;
    for (let j = i + 1; j < live.length; j++) {
      const after = next.indexOf(live[j]!);
      if (after >= 0) {
        at = after;
        break;
      }
    }
    next.splice(at, 0, id);
    known.add(id);
  }
  return next;
}

export const DECK_CHROME_FROM = 0.6;

export const PAGE_BAR_GONE_AT = 0.85;
export const PAGE_BAR_WHOLE_AT = 0.35;

export function pageBarGhostOpacity(positionProgress: number): number {
  "worklet";
  return Math.min(1, Math.max(0, (PAGE_BAR_GONE_AT - positionProgress) / (PAGE_BAR_GONE_AT - PAGE_BAR_WHOLE_AT)));
}

export function deckChromeOpacity(positionProgress: number): number {
  "worklet";
  if (positionProgress >= 1 - 1e-3) return 1;
  return Math.min(1, Math.max(0, (positionProgress - DECK_CHROME_FROM) / (1 - DECK_CHROME_FROM)));
}
