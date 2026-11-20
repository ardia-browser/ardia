import { DECK, deckLeading, lerp, type DeckGeometry } from "./deckGeometry.ts";

export type PullTarget = {
  id: string;
  screenWidth: number;
  screenHeight: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  corner: number;
  screenCorner: number;
  reach: number;
  pull: number;
};

export type PagePose = { x: number; y: number; scale: number; corner: number };

export const DECK_PULL = {
  minReach: 80,
  travelShare: 0.34,
  followResponse: 0.12,
  tuckScale: 0.8,
  overshoot: 0.35,
  landsTravel: 90,
  flick: 900,
  flickTravel: 16,
  back: 250,
  maxSpeed: 14,
  landResponse: 0.34,
  landDamping: 1,
  revealResponse: 0.38,
  growResponse: 0.18,
  backResponse: 0.28,
  backDamping: 1,
  glyphsGoneAt: 44,
  glyphsFadeFrom: 8,
  ghostsFrom: 36,
  ghostsWholeAt: 66,
  barClearance: 4,
  barReturnSlack: 8,
  fadeMs: 150,
  barBackMs: 150,
  barBackCapMs: 600,
  hitchMs: 50,
  standbyCapMs: 500,
  captureCapMs: 180,
  paintCapMs: 250,
  paintDeadlineMs: 1000,
} as const;

const springOf = (response: number, dampingFraction: number) => {
  const stiffness = ((2 * Math.PI) / response) ** 2;
  return { stiffness, damping: 2 * dampingFraction * Math.sqrt(stiffness), mass: 1 };
};

export const DECK_PULL_SPRING = { land: springOf(DECK_PULL.landResponse, DECK_PULL.landDamping), reveal: springOf(DECK_PULL.revealResponse, 1), back: springOf(DECK_PULL.backResponse, DECK_PULL.backDamping), grow: springOf(DECK_PULL.growResponse, 1), follow: springOf(DECK_PULL.followResponse, 1) } as const;

export function pullTarget(id: string, screenWidth: number, screenHeight: number, frame: { centerX: number; centerY: number; width: number; height: number }, corner: number, screenCorner: number): PullTarget {
  const reach = Math.max(screenHeight - (frame.centerY + frame.height / 2), DECK_PULL.minReach);
  return {
    id,
    screenWidth,
    screenHeight,
    width: frame.width,
    height: frame.height,
    centerX: frame.centerX,
    centerY: frame.centerY,
    corner,
    screenCorner,
    reach,
    pull: Math.max(reach, screenHeight * DECK_PULL.travelShare),
  };
}

export function stackPullTarget(g: DeckGeometry, id: string, index: number, scroll: number, shift: number): PullTarget {
  return pullTarget(id, g.width, g.height, { centerX: deckLeading(g, index - scroll) + g.cardWidth / 2, centerY: g.cardCenterY + shift, width: g.cardWidth, height: g.cardHeight }, DECK.cardRadius, g.screenCorner);
}

export function pullShrink(travel: number, pull: number): number {
  "worklet";
  const raw = Math.max(travel, 0) / Math.max(pull, 1);
  if (raw <= 1) return raw;
  return 1 + DECK_PULL.overshoot * (1 - Math.exp(-(raw - 1) / DECK_PULL.overshoot));
}

export function pullHeld(shrink: number): number {
  "worklet";
  return Math.min(Math.max(shrink, 0), 1);
}

export function pullPagePose(target: PullTarget, shrink: number): PagePose {
  "worklet";
  const held = pullHeld(shrink);
  return {
    x: lerp(target.screenWidth / 2, target.centerX, held),
    y: lerp(target.screenHeight / 2, target.centerY, held) - Math.max(shrink - 1, 0) * target.reach,
    scale: lerp(1, target.width / Math.max(target.screenWidth, 1), held),
    corner: lerp(target.screenCorner, target.corner, held),
  };
}

export function pullLands(travel: number, velocityY: number): boolean {
  "worklet";
  if (velocityY >= DECK_PULL.back) return false;
  if (travel >= DECK_PULL.landsTravel) return true;
  return -velocityY >= DECK_PULL.flick && travel >= DECK_PULL.flickTravel;
}

export function pullSpeed(velocityY: number, pull: number): number {
  "worklet";
  return Math.min(Math.max(-velocityY / Math.max(pull, 1), -DECK_PULL.maxSpeed), DECK_PULL.maxSpeed);
}

export type Tucked = { x: number; y: number; scale: number };

export function pullTuck(behind: { x: number; y: number }, slot: { x: number; y: number }, reveal: number): Tucked {
  "worklet";
  const out = Math.min(Math.max(reveal, 0), 1);
  return { x: lerp(behind.x, slot.x, out), y: lerp(behind.y, slot.y, out), scale: lerp(DECK_PULL.tuckScale, 1, out) };
}

export function pullRise(target: PullTarget, shrink: number): number {
  "worklet";
  return Math.max(shrink, 0) * target.reach;
}

export function pullBarGlyphs(rise: number): number {
  "worklet";
  return 1 - Math.min(Math.max((rise - DECK_PULL.glyphsFadeFrom) / (DECK_PULL.glyphsGoneAt - DECK_PULL.glyphsFadeFrom), 0), 1);
}

export function pullBarGhosts(rise: number): number {
  "worklet";
  return Math.min(Math.max((rise - DECK_PULL.ghostsFrom) / (DECK_PULL.ghostsWholeAt - DECK_PULL.ghostsFrom), 0), 1);
}

export function pullClearsBar(rise: number, barTop: number, cleared: boolean): boolean {
  "worklet";
  const clear = barTop + DECK_PULL.barClearance;
  return rise >= (cleared ? clear - DECK_PULL.barReturnSlack : clear);
}

export function pullBarShift(rise: number, barTop: number, drop: number): number {
  "worklet";
  return drop * Math.min(Math.max(rise / Math.max(barTop + DECK_PULL.barClearance, 1), 0), 1);
}
