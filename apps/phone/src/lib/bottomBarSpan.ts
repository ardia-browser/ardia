import { FLOATING_BAR_PLACE, type DeckStrip } from "./deckGeometry.ts";

export type BarSpan = { left: number; right: number };

export type ScreenHinge = "none" | "closed" | "partiallyOpen" | "fullyOpen";

export type DuoStrip = { side: "left" | "right"; centerX: number; plus: number; tabs: number; ends: boolean };

export type BottomBarLayout = { span: BarSpan; strip: DuoStrip | null };

export const DUO_BAR = { openFrom: 600, openWidth: 400, stripGap: 12, button: FLOATING_BAR_PLACE.control, axis: 48, buttonGap: 7, menuGap: 8 } as const;

export const DUO_PLUS_ABOVE = DUO_BAR.button + DUO_BAR.buttonGap;

export const isOpenDuo = (width: number, hinge: ScreenHinge) => (hinge === "fullyOpen" || hinge === "partiallyOpen") && width >= DUO_BAR.openFrom;

export function bottomBarLayout(width: number, insets: { left: number; right: number }, hinge: ScreenHinge, side: number): BottomBarLayout {
  const stripLeft = insets.left > insets.right;
  const inset = stripLeft ? insets.left : insets.right;
  if (hinge === "none" || inset < DUO_BAR.button) {
    const safe = inset + side;
    return { span: { left: safe, right: safe }, strip: null };
  }
  const fromEdge = Math.min(DUO_BAR.axis, inset - DUO_BAR.button / 2);
  const open = isOpenDuo(width, hinge);
  const near = open ? fromEdge - DUO_BAR.button / 2 : inset + DUO_BAR.stripGap;
  const far = open ? Math.max(side, width - near - DUO_BAR.openWidth) : side;
  const slots = open ? { plus: -2 * DUO_PLUS_ABOVE, tabs: -DUO_PLUS_ABOVE, ends: true } : { plus: -DUO_PLUS_ABOVE, tabs: 0, ends: false };
  return stripLeft ? { span: { left: near, right: far }, strip: { side: "left", centerX: fromEdge, ...slots } } : { span: { left: far, right: near }, strip: { side: "right", centerX: width - fromEdge, ...slots } };
}

export type DuoSqueeze = { marginLeft: number; marginRight: number };

export function duoSqueeze(width: number, layout: BottomBarLayout): DuoSqueeze | null {
  const { span, strip } = layout;
  if (!strip?.ends) return null;
  const half = DUO_BAR.button / 2;
  return { marginLeft: strip.centerX - half - span.left, marginRight: width - span.right - (strip.centerX + half) };
}

export const barSwipeSpan = (width: number, layout: BottomBarLayout) => (layout.strip?.ends ? Math.min(Math.max(width - layout.span.left - layout.span.right, 0), width) : width);

export const barSpanCenter = (width: number, span: BarSpan) => (span.left + width - span.right) / 2;

export function besideStrip(strip: DuoStrip, width: number, menuWidth: number, margin: number) {
  const away = DUO_BAR.button / 2 + DUO_BAR.menuGap;
  const room = (strip.side === "right" ? strip.centerX : width - strip.centerX) - away - margin;
  const fitted = Math.max(Math.min(menuWidth, room), 0);
  return strip.side === "right" ? { right: width - strip.centerX + away, width: fitted } : { left: strip.centerX + away, width: fitted };
}

export const deckStripOf = (layout: BottomBarLayout, insets: { left: number; right: number }): DeckStrip | null => (layout.strip ? { side: layout.strip.side, inset: layout.strip.side === "left" ? insets.left : insets.right } : null);

export function deckHeaderSides(insets: { left: number; right: number }, side: number): BarSpan {
  const safe = Math.max(insets.left, insets.right) + side;
  return { left: safe, right: safe };
}

export const DECK_STRIP_SLOTS = { more: -2 * DUO_PLUS_ABOVE, incognito: -DUO_PLUS_ABOVE, plus: 0 } as const;

export const DECK_DUO_ROW = { openWidth: 460, stripGap: 8, spacesShare: 0.4 } as const;

export function deckBarSpan(width: number, layout: BottomBarLayout, insets: { left: number; right: number }, side: number): BarSpan {
  const { span, strip } = layout;
  if (!strip?.ends) return span;
  const near = (strip.side === "left" ? insets.left : insets.right) + DECK_DUO_ROW.stripGap;
  const far = Math.max(side, width - near - DECK_DUO_ROW.openWidth);
  return strip.side === "left" ? { left: near, right: far } : { left: far, right: near };
}

export type DeckSpacesSlot = { anchor: "start" | "end"; from: number; to: number; maxWidth: number; covered: boolean };

export function deckSpacesSlot(width: number, span: BarSpan, strip: DuoStrip | null, gap: number): DeckSpacesSlot | null {
  if (!strip) return null;
  const from = span.left;
  const to = width - span.right;
  return { anchor: strip.side === "right" ? "start" : "end", from, to, maxWidth: Math.max((to - from) * DECK_DUO_ROW.spacesShare - gap, 0), covered: !strip.ends };
}

export function deckSpacesMenu(slot: DeckSpacesSlot, capsuleWidth: number, menuWidth: number) {
  const fitted = Math.max(Math.min(menuWidth, slot.to - slot.from), 0);
  const capsuleLeft = slot.anchor === "start" ? slot.from : slot.to - capsuleWidth;
  return { left: Math.min(Math.max(capsuleLeft, slot.from), slot.to - fitted), width: fitted };
}
