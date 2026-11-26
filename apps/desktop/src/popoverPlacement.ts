export type PlacementRect = { x: number; y: number; width: number; height: number };
export type PopoverSide = "bottom" | "top" | "left" | "right";
export type PopoverAlign = "start" | "center" | "end";

export type PlacementRequest = {
  anchor: PlacementRect;
  size: { width: number; height: number };
  area: PlacementRect;
  side?: PopoverSide;
  align?: PopoverAlign;
  gap?: number;
  margin?: number;
  scale?: number;
};

export type Placement = { rect: PlacementRect; side: PopoverSide; flipped: boolean; clamped: boolean; arrowOffset: number };

const OPPOSITE: Record<PopoverSide, PopoverSide> = { bottom: "top", top: "bottom", left: "right", right: "left" };
const vertical = (side: PopoverSide) => side === "top" || side === "bottom";

export const deviceScale = (scale: number | undefined) => (typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1);

export function snapToDevice(value: number, scale: number) {
  const ratio = deviceScale(scale);
  return Math.round(value * ratio) / ratio;
}

export const finite = (value: number | undefined, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const extent = (value: number | undefined) => Math.max(0, finite(value));
export const cleanRect = (rect: PlacementRect): PlacementRect => ({ x: finite(rect?.x), y: finite(rect?.y), width: extent(rect?.width), height: extent(rect?.height) });

function room(side: PopoverSide, anchor: PlacementRect, area: PlacementRect, gap: number, margin: { x: number; y: number }) {
  if (side === "bottom") return area.y + area.height - margin.y - (anchor.y + anchor.height + gap);
  if (side === "top") return anchor.y - gap - (area.y + margin.y);
  if (side === "right") return area.x + area.width - margin.x - (anchor.x + anchor.width + gap);
  return anchor.x - gap - (area.x + margin.x);
}

function clampSpan(start: number, length: number, low: number, high: number) {
  if (length >= high - low) return low;
  return Math.min(Math.max(start, low), high - length);
}

function snapSpan(start: number, length: number, low: number, high: number, scale: number) {
  const ratio = deviceScale(scale);
  const floorEdge = Math.ceil(low * ratio - 1e-9) / ratio;
  const ceilEdge = Math.floor(high * ratio + 1e-9) / ratio;
  if (floorEdge > ceilEdge) return { start: Math.min(Math.max(start, low), high), length: 0 };
  const within = (value: number) => Math.min(Math.max(value, low), high);
  const begin = within(Math.min(Math.max(snapToDevice(start, ratio), floorEdge), ceilEdge));
  const end = within(Math.min(Math.max(snapToDevice(start + length, ratio), begin), ceilEdge));
  return { start: begin, length: Math.max(0, end - begin) };
}

export function placePopover(request: PlacementRequest): Placement {
  const anchor = cleanRect(request.anchor);
  const area = cleanRect(request.area);
  const size = { width: extent(request.size?.width), height: extent(request.size?.height) };
  const side = request.side ?? "bottom";
  const align = request.align ?? "center";
  const gap = Math.max(0, finite(request.gap, 4));
  const wanted = Math.max(0, finite(request.margin, 8));
  const margin = { x: Math.min(wanted, Math.floor(area.width / 2)), y: Math.min(wanted, Math.floor(area.height / 2)) };
  const scale = deviceScale(request.scale);
  const need = vertical(side) ? size.height : size.width;
  const preferred = room(side, anchor, area, gap, margin);
  const opposite = room(OPPOSITE[side], anchor, area, gap, margin);
  const flipped = preferred < need && opposite > preferred;
  const chosen = flipped ? OPPOSITE[side] : side;
  const alongY = vertical(chosen);
  const crossLength = alongY ? size.width : size.height;
  const mainLength = alongY ? size.height : size.width;
  const anchorCrossStart = alongY ? anchor.x : anchor.y;
  const anchorCrossLength = alongY ? anchor.width : anchor.height;
  const crossStart = align === "start" ? anchorCrossStart : align === "end" ? anchorCrossStart + anchorCrossLength - crossLength : anchorCrossStart + (anchorCrossLength - crossLength) / 2;
  const mainStart =
    chosen === "bottom" ? anchor.y + anchor.height + gap : chosen === "top" ? anchor.y - gap - size.height : chosen === "right" ? anchor.x + anchor.width + gap : anchor.x - gap - size.width;
  const crossMargin = alongY ? margin.x : margin.y;
  const mainMargin = alongY ? margin.y : margin.x;
  const crossLow = (alongY ? area.x : area.y) + crossMargin;
  const crossHigh = (alongY ? area.x + area.width : area.y + area.height) - crossMargin;
  const mainLow = (alongY ? area.y : area.x) + mainMargin;
  const mainHigh = (alongY ? area.y + area.height : area.x + area.width) - mainMargin;
  const cross = clampSpan(crossStart, crossLength, crossLow, crossHigh);
  const main = clampSpan(mainStart, mainLength, mainLow, mainHigh);
  const crossSpan = snapSpan(cross, Math.min(crossLength, crossHigh - crossLow), crossLow, crossHigh, scale);
  const mainSpan = snapSpan(main, Math.min(mainLength, mainHigh - mainLow), mainLow, mainHigh, scale);
  const rect = alongY
    ? { x: crossSpan.start, y: mainSpan.start, width: crossSpan.length, height: mainSpan.length }
    : { x: mainSpan.start, y: crossSpan.start, width: mainSpan.length, height: crossSpan.length };
  const anchorCenter = anchorCrossStart + anchorCrossLength / 2;
  const arrowOffset = snapToDevice(Math.min(Math.max(anchorCenter - crossSpan.start, 0), crossSpan.length), scale);
  const clamped = Math.abs(cross - crossStart) > 1e-6 || Math.abs(main - mainStart) > 1e-6 || rect.width < size.width || rect.height < size.height;
  return { rect, side: chosen, flipped, clamped, arrowOffset };
}
