import { FLOATING_BAR_PLACE } from "./deckGeometry.ts";

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

export type DuoFieldReach = { side: "marginLeft" | "marginRight"; rest: number; open: number; typing: number };

export function duoFieldReach(width: number, layout: BottomBarLayout, side: number): DuoFieldReach | null {
  const { span, strip } = layout;
  if (!strip?.ends) return null;
  const far = strip.side === "right" ? span.left : span.right;
  return { side: strip.side === "right" ? "marginLeft" : "marginRight", rest: Math.max(width - span.left - span.right - DUO_BAR.button, 0), open: 0, typing: side - far };
}

export const barSpanCenter = (width: number, span: BarSpan) => (span.left + width - span.right) / 2;

export function besideStrip(strip: DuoStrip, width: number, menuWidth: number, margin: number) {
  const away = DUO_BAR.button / 2 + DUO_BAR.menuGap;
  const room = (strip.side === "right" ? strip.centerX : width - strip.centerX) - away - margin;
  const fitted = Math.max(Math.min(menuWidth, room), 0);
  return strip.side === "right" ? { right: width - strip.centerX + away, width: fitted } : { left: strip.centerX + away, width: fitted };
}
