import { FLOATING_BAR_PLACE, type DeckStrip } from "./deckGeometry.ts";

export type BarSpan = { left: number; right: number };

export type ScreenHinge = "none" | "closed" | "partiallyOpen" | "fullyOpen";

export type DuoStrip = { side: "left" | "right"; centerX: number; plus: number; tabs: number; ends: boolean };

export type BottomBarLayout = { span: BarSpan; strip: DuoStrip | null };

export const DUO_BAR = { openFrom: 600, openWidth: 400, stripGap: 12, button: FLOATING_BAR_PLACE.control, axis: 48, buttonGap: 7, menuGap: 8, slotGap: 8 } as const;

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

export type DuoFieldReach = { side: "marginLeft" | "marginRight"; rest: number; open: number; typing: number };

export function duoFieldReach(width: number, layout: BottomBarLayout, side: number): DuoFieldReach | null {
  const { span, strip } = layout;
  if (!strip?.ends) return null;
  const far = strip.side === "right" ? span.left : span.right;
  return { side: strip.side === "right" ? "marginLeft" : "marginRight", rest: Math.max(width - span.left - span.right - DUO_BAR.button, 0), open: 0, typing: side - far };
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

export type DeckStripSlots = { more: number; plus: number; incognito: number };

export const deckStripSlots = (strip: DuoStrip): DeckStripSlots => (strip.ends ? { more: strip.plus - DUO_PLUS_ABOVE, plus: strip.plus, incognito: strip.tabs } : { more: strip.plus - DUO_PLUS_ABOVE, plus: strip.tabs, incognito: strip.plus });

export type DeckSpacesSlot = { inRow: boolean; anchor: "start" | "end"; at: number; from: number; to: number; maxWidth: number };

export function deckSpacesSlot(width: number, layout: BottomBarLayout, side: number, gap: number): DeckSpacesSlot | null {
  const { span, strip } = layout;
  if (!strip) return null;
  const rowFrom = span.left;
  const rowTo = width - span.right;
  if (!strip.ends) {
    const maxWidth = (rowTo - rowFrom - gap) / 2;
    return strip.side === "right" ? { inRow: true, anchor: "start", at: rowFrom, from: rowFrom, to: rowTo, maxWidth } : { inRow: true, anchor: "end", at: rowTo, from: rowFrom, to: rowTo, maxWidth };
  }
  const beside = DUO_BAR.button / 2 + DUO_BAR.slotGap;
  const maxWidth = DUO_BAR.openWidth / 2;
  return strip.side === "right" ? { inRow: false, anchor: "end", at: strip.centerX - beside, from: side, to: strip.centerX - beside, maxWidth } : { inRow: false, anchor: "start", at: strip.centerX + beside, from: strip.centerX + beside, to: width - side, maxWidth };
}

export function deckSpacesMenu(slot: DeckSpacesSlot, capsuleWidth: number, menuWidth: number) {
  const fitted = Math.max(Math.min(menuWidth, slot.to - slot.from), 0);
  const capsuleLeft = slot.anchor === "start" ? slot.at : slot.at - capsuleWidth;
  return { left: Math.min(Math.max(capsuleLeft, slot.from), slot.to - fitted), width: fitted };
}
