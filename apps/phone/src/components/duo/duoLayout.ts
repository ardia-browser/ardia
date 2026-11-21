import type { ScreenFold } from "../../state/app/screenLayout.ts";

export const DUO = Object.freeze({
  cardInset: 11,
  cardTop: 33,
  cardBottom: 9,
  cardBelowStatus: 4,
  cardIntoHomeIndicator: 20,
  cardRadius: 16,
  cardMinHeight: 120,
  toolbarInset: 8,
  toolbarTop: 9,
  toolbarButton: 45,
  toolbarGap: 7,
  toolbarGlyph: 18,
  toolbarClearance: 9 * 2 + 45,
  addressHeight: 44,
  addressLead: 16,
  addressTrail: 20,
  addressSidebarInset: 8,
  addressGap: 10,
  addressSidebarButton: 30,
  sidebarGlyph: 17,
  hostText: 15,
  hostLock: 13,
  hostGap: 7,
  hostMaxTextScale: 19 / 15,
  sidebarWidth: 260,
  sidebarRadius: 16,
  sidebarPadding: 10,
  sidebarHeaderHeight: 50,
  sidebarHeaderTop: 25,
  sidebarHeaderLead: 14,
  sidebarHeaderGap: 4,
  sidebarFieldHeight: 43,
  sidebarFieldPadding: 18,
  sidebarRowHeight: 41,
  sidebarRowPitch: 46,
  sidebarRowRadius: 11,
  sidebarRowLead: 13,
  sidebarRowIcon: 18,
  sidebarRowGap: 12,
  sidebarRowClose: 44,
  sidebarCloseGlyph: 13,
  sidebarPrivateGlyph: 14,
  sidebarPlusGlyph: 16,
  sidebarMoreGlyph: 17,
  sidebarSectionTop: 10,
  sidebarHeadingLead: 13 + 6,
  sidebarHeadingTop: 10 + 6,
  sidebarHeadingBottom: 4,
  sidebarTilesPerRow: 2,
  sidebarDotsTop: 8,
  sidebarDotsBottom: 26,
  hitTarget: 44,
  panelTop: 16,
  commandTop: 127,
  commandSide: 27,
  commandPanelInset: 8,
  commandMaxHeight: 484,
  commandAboveKeyboard: 24,
  commandRestScale: 0.96,
});

export type DuoInsets = { top: number; bottom: number; left: number; right: number };

export type DuoFrame = { x: number; y: number; width: number; height: number };

export const duoCardTop = (safeTop: number) => Math.max(DUO.cardTop, safeTop + DUO.cardBelowStatus);

export const duoCardBottom = (safeBottom: number) => Math.max(DUO.cardBottom, safeBottom - DUO.cardIntoHomeIndicator);

export function wideCardFrame(width: number, height: number, insets: DuoInsets): DuoFrame {
  const y = duoCardTop(insets.top);
  return { x: DUO.cardInset + insets.left, y, width: width - DUO.cardInset * 2 - insets.left - insets.right, height: height - y - duoCardBottom(insets.bottom) };
}

export function splitCardFrame(width: number, insets: DuoInsets, fold: ScreenFold): DuoFrame {
  const y = duoCardTop(insets.top);
  return { x: DUO.cardInset, y, width: width - DUO.cardInset * 2, height: Math.max(fold.top - y - DUO.cardInset, DUO.cardMinHeight) };
}

export const toolbarFrame = (card: DuoFrame): DuoFrame => ({ x: card.x, y: card.y + DUO.toolbarTop, width: card.width, height: DUO.toolbarButton });

export type ToolbarLayout = { leadingEnd: number; trailingStart: number; addressCenterX: number; addressMaxWidth: number };

export function toolbarLayout(width: number): ToolbarLayout {
  const leadingEnd = DUO.toolbarInset + 3 * DUO.toolbarButton + 2 * DUO.toolbarGap;
  const trailingStart = width - DUO.toolbarInset - 2 * DUO.toolbarButton - DUO.toolbarGap;
  const slack = 3 * DUO.toolbarGap;
  return { leadingEnd, trailingStart, addressCenterX: (leadingEnd + trailingStart) / 2, addressMaxWidth: Math.max(trailingStart - leadingEnd - 2 * slack, 0) };
}

export function sidebarFrame(width: number, height: number, insets: DuoInsets): DuoFrame {
  return { x: DUO.cardInset + insets.left, y: DUO.cardInset, width: Math.min(DUO.sidebarWidth, width), height: height - DUO.cardInset - duoCardBottom(insets.bottom) };
}

export type PanelFrame = DuoFrame & { paddingBottom: number };

export const splitPanelFrame = (width: number, height: number, insets: DuoInsets, fold: ScreenFold): PanelFrame => ({ x: 0, y: fold.bottom, width, height: Math.max(height - fold.bottom, 0), paddingBottom: insets.bottom });

export type CommandBarPlacement = { top: number; left: number; width: number; maxHeight: number };

export function commandBarPlacement(width: number, insets: DuoInsets, keyboardTop: number): CommandBarPlacement {
  const top = duoCardTop(insets.top) + DUO.commandTop;
  const side = DUO.commandSide + DUO.commandPanelInset;
  return {
    top,
    left: insets.left + side,
    width: Math.max(width - insets.left - insets.right - side * 2, 0),
    maxHeight: Math.max(Math.min(DUO.commandMaxHeight, keyboardTop - top - DUO.commandAboveKeyboard), 0),
  };
}

export const commandBarKeyboardTop = (height: number, lift: number) => height - lift;

export function commandBarRise(rise: number, reduceMotion: boolean) {
  "worklet";
  const shown = Math.min(Math.max(rise, 0), 1);
  return { opacity: shown, scale: reduceMotion ? 1 : DUO.commandRestScale + (1 - DUO.commandRestScale) * shown };
}
