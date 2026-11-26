import type { PeekStageGeometry } from "../ui";

export type PeekRect = { x: number; y: number; width: number; height: number };

type PeekLayoutInput = {
  width: number;
  height: number;
  pageTop: number;
  bar: number;
  inset: number;
  restRadius: number;
  paneRadius: number;
  from: { x: number; y: number } | null;
  fullscreen: boolean;
  fitToTab?: boolean;
  atTabSize?: boolean;
  sideRoom?: { left: number; right: number };
};

const INSET_FRACTION = 0.055;
const MIN_INSET = 16;
const SOURCE_WIDTH = 28;
const SOURCE_HEIGHT = 18;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function peekGeometry(o: PeekLayoutInput): PeekStageGeometry {
  const page: PeekRect = o.fullscreen ? { x: 0, y: 0, width: o.width, height: o.height } : { x: 0, y: o.pageTop, width: o.width, height: Math.max(1, o.height - o.pageTop) };
  const ix = Math.max(MIN_INSET, Math.round(o.width * INSET_FRACTION));
  const iy = Math.max(MIN_INSET, Math.round(o.height * INSET_FRACTION));
  const left = Math.max(ix, o.sideRoom?.left ?? 0), right = Math.max(ix, o.sideRoom?.right ?? 0);
  const room = { width: Math.max(1, o.width - left - right - 2 * o.inset), height: Math.max(1, o.height - 2 * iy - o.bar - o.inset) };
  const k = Math.max(0.05, Math.min(room.width / page.width, room.height / page.height, 1));
  const restSize = { width: page.width * k, height: page.height * k };
  const cardWidth = restSize.width + 2 * o.inset;
  const cardHeight = restSize.height + o.bar + o.inset;
  const fitted = o.fitToTab !== false;
  const card: PeekRect = fitted
    ? { x: left + (o.width - left - right - cardWidth) / 2, y: (o.height - cardHeight) / 2, width: cardWidth, height: cardHeight }
    : { x: left, y: iy, width: Math.max(1, o.width - left - right), height: Math.max(1, o.height - 2 * iy) };
  const rest: PeekRect = fitted
    ? { x: card.x + o.inset, y: card.y + o.bar, ...restSize }
    : { x: card.x + o.inset, y: card.y + o.bar, width: Math.max(1, card.width - 2 * o.inset), height: Math.max(1, card.height - o.bar - o.inset) };
  const at = o.from ?? { x: card.x + card.width / 2, y: card.y + card.height / 2 };
  const source: PeekRect = {
    x: clamp(at.x - SOURCE_WIDTH / 2, 0, o.width - SOURCE_WIDTH),
    y: clamp(at.y - SOURCE_HEIGHT / 2, 0, o.height - SOURCE_HEIGHT),
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT,
  };
  return {
    width: o.width,
    height: o.height,
    page: o.fullscreen || (fitted && o.atTabSize) ? page : rest,
    tab: page,
    rest,
    card,
    source,
    restRadius: o.restRadius,
    tabTopRadius: o.fullscreen || o.pageTop > 0 ? 0 : o.paneRadius,
    tabBottomRadius: o.fullscreen ? 0 : o.paneRadius,
    fullscreen: o.fullscreen,
  };
}
