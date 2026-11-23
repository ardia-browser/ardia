import { deckLeading, deckPileScale, lerp, type DeckGeometry } from "./deckGeometry.ts";
import { CARD_MOVE_RESPONSE, GLASS_FADE_MS } from "./sharedMotion.ts";

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
  landResponse: CARD_MOVE_RESPONSE,
  growResponse: CARD_MOVE_RESPONSE,
  hurryResponse: 0.07,
  hurryLanding: 1 + 1e-6,
  settleEnergy: 1e-4,
  backResponse: 0.28,
  backDamping: 1,
  glyphsGoneAt: 44,
  glyphsFadeFrom: 8,
  ghostsFrom: 36,
  ghostsWholeAt: 66,
  barClearance: 4,
  barReturnSlack: 8,
  fadeMs: 150,
  barBackMs: GLASS_FADE_MS,
  barBackCapMs: 600,
  hitchMs: 50,
  growLostMs: 600,
} as const;

const springOf = (response: number, dampingFraction: number) => {
  const stiffness = ((2 * Math.PI) / response) ** 2;
  return { stiffness, damping: 2 * dampingFraction * Math.sqrt(stiffness), mass: 1 };
};

const settlingSpringOf = (response: number) => ({ ...springOf(response, 1), energyThreshold: DECK_PULL.settleEnergy });

export const DECK_PULL_SPRING = {
  land: settlingSpringOf(DECK_PULL.landResponse),
  hurry: settlingSpringOf(DECK_PULL.hurryResponse),
  back: springOf(DECK_PULL.backResponse, DECK_PULL.backDamping),
  grow: settlingSpringOf(DECK_PULL.growResponse),
  follow: springOf(DECK_PULL.followResponse, 1),
} as const;

export type DeckHit = { ids: readonly string[]; scroll: number; g: DeckGeometry };

export function deckCardAt(hit: DeckHit, x: number, y: number): string | null {
  "worklet";
  const { g, ids, scroll } = hit;
  for (let index = ids.length - 1; index >= 0; index--) {
    const relative = index - scroll;
    const scale = deckPileScale(g, relative);
    const left = deckLeading(g, relative) + (g.cardWidth * (1 - scale)) / 2;
    const half = (g.cardHeight * scale) / 2;
    if (x >= left && x <= left + g.cardWidth * scale && y >= g.cardCenterY - half && y <= g.cardCenterY + half) return ids[index] ?? null;
  }
  return null;
}

export function landingVelocity(shrink: number, velocity: number): number {
  "worklet";
  const reach = ((2 * Math.PI) / DECK_PULL.landResponse) * (1 - shrink);
  return reach >= 0 ? Math.min(velocity, reach) : Math.max(velocity, reach);
}

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
  const scale = deckPileScale(g, index - scroll);
  return pullTarget(id, g.width, g.height, { centerX: deckLeading(g, index - scroll) + g.cardWidth / 2, centerY: g.cardCenterY + shift, width: g.cardWidth * scale, height: g.cardHeight * scale }, g.cardCorner * scale, g.screenCorner);
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

export function pullTuck(behind: { x: number; y: number }, slot: { x: number; y: number; scale?: number }, reveal: number): Tucked {
  "worklet";
  const out = Math.min(Math.max(reveal, 0), 1);
  return { x: lerp(behind.x, slot.x, out), y: lerp(behind.y, slot.y, out), scale: lerp(DECK_PULL.tuckScale, slot.scale ?? 1, out) };
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
