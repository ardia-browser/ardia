import { deckGeometry, deckLeading, deckVisibleWidth, type DeckGeometry } from "../../lib/deckGeometry";
import type { MaterialScheme } from "../../lib/material/schemes";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialBottomBar, materialSize } from "../ui/materialTokens";
import { tabsLayout } from "../ui/tokens";

export const MATERIAL_DECK = {
  edge: 16,
  rowGap: 12,
  barSide: 4,
  titleInset: 12,
  closeIcon: 18,
  closeRipple: 20,
  closeShownFrom: materialSize.touchTarget + 24,
  headerInset: 4,
  chipHeight: 32,
  chipGlyph: 18,
  fabElevation: 6,
  cardElevation: 14,
  searchGap: 16,
  keyboardGap: 8,
} as const;

const REDESIGN_BAR_ABOVE_SAFE_BOTTOM = 11;

export const materialBottomRowCenter = (safeBottom: number) => safeBottom + materialBottomBar.inset + materialBottomBar.height / 2;

export function fitsMaterialChrome(g: DeckGeometry): boolean {
  const cardTop = g.cardCenterY - g.cardHeight / 2;
  const titleRowTop = cardTop - tabsLayout.headerGap - tabsLayout.headerHeight;
  const rowTop = g.height - g.safeBottom - materialBottomBar.inset - materialBottomBar.height;
  return titleRowTop >= g.safeTop + materialSize.topAppBar && g.cardCenterY + g.cardHeight / 2 <= rowTop;
}

export function materialDeckGeometry(width: number, height: number, safeTop: number, safeBottom: number, safeSide: number, os: string, classicChrome: number, screenCorner: number): DeckGeometry {
  const classic = deckGeometry(width, height, safeTop, safeBottom, safeSide, os, "material", classicChrome, screenCorner);
  if (fitsMaterialChrome(classic)) return classic;
  const rowCenter = materialBottomRowCenter(safeBottom);
  const between = deckGeometry(width, height, safeTop, rowCenter - REDESIGN_BAR_ABOVE_SAFE_BOTTOM, safeSide, "ios", "redesigned", materialSize.topAppBar, screenCorner);
  return { ...between, safeBottom };
}

export function materialOnScreen(g: DeckGeometry, left: number, visible: number): number {
  "worklet";
  return Math.max(0, Math.min(visible, g.width - g.safeSide - MATERIAL_DECK.edge - left));
}

export function materialCloseCenter(g: DeckGeometry, relative: number, isLast: boolean): { x: number; y: number; visible: number } {
  "worklet";
  const visible = materialOnScreen(g, deckLeading(g, relative), deckVisibleWidth(g, relative, isLast));
  const cardTop = g.cardCenterY - g.cardHeight / 2;
  return { x: deckLeading(g, relative) + visible - materialSize.touchTarget / 2, y: cardTop - tabsLayout.headerGap - tabsLayout.headerHeight / 2, visible };
}

export function materialCloseHit(g: DeckGeometry, relative: number, isLast: boolean, x: number, y: number): boolean {
  "worklet";
  const close = materialCloseCenter(g, relative, isLast);
  const half = materialSize.touchTarget / 2;
  return close.visible >= MATERIAL_DECK.closeShownFrom && Math.abs(x - close.x) <= half && Math.abs(y - close.y) <= half;
}

export function materialCloseAt(g: DeckGeometry, count: number, scroll: number, x: number, y: number): number {
  "worklet";
  for (let index = count - 1; index >= 0; index--) if (materialCloseHit(g, index - scroll, index === count - 1, x, y)) return index;
  return -1;
}

export function useDeckScheme(incognito: boolean): MaterialScheme {
  return useMaterialTheme(incognito).scheme;
}
