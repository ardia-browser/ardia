export type HoleSamples = { durationMs: number; rects: number[][]; offsets: number[] };
export type LocalRect = { x: number; y: number; width: number; height: number };
export type ShownPage = LocalRect & { radius: number };
export type Corners = [number, number, number, number];
export type Hole = ShownPage & { corners: Corners };

export const UNPAINTED_SLOT = { light: "#ffffff", dark: "#1c1c1e" } as const;
const SPREAD_SLOP = 16;
const SMALLEST_SCALE = 0.01;
const DENSEST_FROST = 0.94;
const FROST_BASE = { light: [246, 246, 246], dark: [44, 44, 46] } as const;

export const round = (value: number) => Math.round(value * 100) / 100;

export const slotFill = (visible: boolean | undefined, dark: boolean) => (visible === false ? null : { backgroundColor: dark ? UNPAINTED_SLOT.dark : UNPAINTED_SLOT.light });

export const pagesToCut = <Page>(shown: Map<string, Page>, painted: Set<string>) => new Map([...shown].filter(([key]) => painted.has(key)));

export function holeRectAt(samples: HoleSamples, elapsed: number): number[] | undefined {
  const { rects, offsets, durationMs } = samples;
  const last = rects.length - 1;
  if (last < 1 || durationMs <= 0) return rects[last];
  const progress = Math.min(1, Math.max(0, elapsed / durationMs));
  const after = offsets.findIndex((offset) => offset >= progress);
  if (after < 0) return rects[last];
  if (after === 0) return rects[0];
  const before = after - 1;
  const span = (offsets[after] ?? 1) - (offsets[before] ?? 0);
  const mix = span > 0 ? (progress - (offsets[before] ?? 0)) / span : 1;
  const from = rects[before];
  const to = rects[after];
  if (!from || !to) return rects[last];
  return from.map((value, index) => value + ((to[index] ?? value) - value) * mix);
}

export function cutOutKeyframes(local: LocalRect[], offsets: number[]): Keyframe[] {
  const base = local[local.length - 1];
  if (!base || base.width <= 0 || base.height <= 0) return [];
  return local.map((rect, index) => ({
    offset: offsets[index] ?? 1,
    transform: `translate(${round(rect.x - base.x)}px, ${round(rect.y - base.y)}px) scale(${round((rect.width / base.width) * 1e4) / 1e4}, ${round((rect.height / base.height) * 1e4) / 1e4})`,
  }));
}

export function cutOutSpread(local: LocalRect[], width: number, height: number): number {
  const base = local[local.length - 1];
  if (!base || base.width <= 0 || base.height <= 0) return 0;
  const smallest = Math.max(SMALLEST_SCALE, Math.min(...local.map((rect) => Math.min(rect.width / base.width, rect.height / base.height))));
  return Math.ceil((Math.max(width, height) * 2) / smallest) + SPREAD_SLOP;
}

function channels(color: string): [number, number, number, number] | null {
  const rgba = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(color);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(color);
  if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
  return null;
}

export function frostOverPage(color: string, dark: boolean): string {
  const tint = channels(color);
  if (!tint) return color;
  const base = dark ? FROST_BASE.dark : FROST_BASE.light;
  const [r, g, b, alpha] = tint;
  const mixed = [r, g, b].map((channel, index) => Math.round(channel * alpha + (base[index] ?? 0) * (1 - alpha)));
  return `rgba(${mixed.join(", ")}, ${Math.max(alpha, DENSEST_FROST)})`;
}

export function holePath(hole: Hole, left: number, top: number): string {
  const x = round(hole.x - left);
  const y = round(hole.y - top);
  const w = round(hole.width);
  const h = round(hole.height);
  const [tl, tr, br, bl] = hole.corners.map((corner) => round(Math.min(corner, w / 2, h / 2))) as Corners;
  return `M${x + tl},${y} H${x + w - tr} A${tr},${tr} 0 0 1 ${x + w},${y + tr} V${y + h - br} A${br},${br} 0 0 1 ${x + w - br},${y + h} H${x + bl} A${bl},${bl} 0 0 1 ${x},${y + h - bl} V${y + tl} A${tl},${tl} 0 0 1 ${x + tl},${y} Z`;
}

const contains = (outer: ShownPage, inner: ShownPage) =>
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;

export function outermost(holes: Hole[]): Hole[] {
  return holes.filter((hole, index) => !holes.some((other, at) => at !== index && contains(other, hole) && (!contains(hole, other) || at < index)));
}

export function motionBounds(samples: HoleSamples): ShownPage {
  const xs = samples.rects.flatMap(([x = 0, , w = 0]) => [x, x + w]);
  const ys = samples.rects.flatMap(([, y = 0, , h = 0]) => [y, y + h]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, radius: 0 };
}
