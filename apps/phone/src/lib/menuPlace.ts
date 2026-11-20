export type Rect = { x: number; y: number; width: number; height: number };

export type Point = { x: number; y: number };

export type MenuSpot = { left: number; top: number; height: number; origin: string };

export type MenuSizes = { row: number; heading: number; divider: number; padding: number };

export const IPHONE_MENU_SIZES: MenuSizes = { row: 42, heading: 30, divider: 20.67, padding: 19 };

export const ANDROID_MENU_SIZES: MenuSizes = { row: 48, heading: 36, divider: 8, padding: 16 };

export const MENU_MARGIN = 8;

type Entry = "divider" | { heading: string } | object;

const entryHeight = (item: Entry, sizes: MenuSizes) => (item === "divider" ? sizes.divider : "heading" in (item as object) ? sizes.heading : sizes.row);

export function menuHeight(items: readonly Entry[], sizes: MenuSizes = IPHONE_MENU_SIZES): number {
  return items.reduce<number>((sum, item) => sum + entryHeight(item, sizes), sizes.padding);
}

export function tallestMenuPage(items: readonly Entry[], sizes: MenuSizes = IPHONE_MENU_SIZES): number {
  return items.reduce<number>((tallest, item) => {
    const children = typeof item === "object" && "children" in (item as object) ? (item as { children: readonly Entry[] }).children : null;
    return children ? Math.max(tallest, sizes.row + menuHeight(children, sizes), tallestMenuPage(children, sizes)) : tallest;
  }, menuHeight(items, sizes));
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

export type MenuAlign = { trailing: boolean; inset: number };

export const MENU_FINGER_GAP = 16;

export function menuOnTrigger(anchor: Rect, host: Rect, room: Rect, width: number, wanted: number, margin: number, keepBelow?: boolean, align?: MenuAlign): MenuSpot {
  const anchorBottom = anchor.y + anchor.height;
  const roomTop = Math.min(room.y + margin, anchor.y);
  const roomBottom = Math.max(room.y + room.height - margin, anchorBottom);
  const roomLeft = Math.min(room.x + margin, anchor.x);
  const roomRight = Math.max(room.x + room.width - margin, anchor.x + anchor.width);
  const height = Math.min(wanted, roomBottom - roomTop);
  const trailing = align ? align.trailing : anchor.x + anchor.width / 2 > room.x + room.width / 2;
  const inset = align ? align.inset : 0;
  const x = clamp(trailing ? anchor.x + anchor.width - inset - width : anchor.x + inset, roomLeft, roomRight - width);
  const below = keepBelow ?? (anchor.y + height <= roomBottom || anchorBottom - height < roomTop);
  const y = clamp(below ? anchor.y : anchorBottom - height, roomTop, roomBottom - height);
  return { left: x - host.x, top: y - host.y, height, origin: `${trailing ? "right" : "left"} ${below ? "top" : "bottom"}` };
}

export const MENU_SMALL_CONTROL = 64;

export type MenuLimits = { control?: Rect | null; floor?: number | null };

export function menuAt(point: Point, host: Rect, room: Rect, width: number, wanted: number, margin: number, keepBelow?: boolean, limits?: MenuLimits): MenuSpot {
  const roomTop = room.y + margin;
  const roomBottom = Math.min(room.y + room.height, limits?.floor ?? Infinity) - margin;
  const control = limits?.control;
  const ceiling = control && control.height <= MENU_SMALL_CONTROL ? Math.min(point.y, control.y) : point.y;
  const height = Math.min(wanted, roomBottom - roomTop);
  const fitsRight = point.x + width + margin <= room.x + room.width;
  const fitsBelow = keepBelow ?? point.y + height <= roomBottom;
  const x = clamp(fitsRight ? point.x : point.x - width, room.x + margin, room.x + room.width - width - margin);
  const y = clamp(fitsBelow ? point.y : ceiling - MENU_FINGER_GAP - height, roomTop, roomBottom - height);
  return { left: x - host.x, top: y - host.y, height, origin: `${fitsRight ? "left" : "right"} ${fitsBelow ? "top" : "bottom"}` };
}

export function menuShrink(anchor: Rect, width: number, height: number): { x: number; y: number } {
  return { x: Math.min(1, anchor.width / width), y: Math.min(1, anchor.height / height) };
}

export function insetRect(rect: Rect, inset: { top: number; bottom: number; left: number; right: number }): Rect {
  return { x: rect.x + inset.left, y: rect.y + inset.top, width: rect.width - inset.left - inset.right, height: rect.height - inset.top - inset.bottom };
}
