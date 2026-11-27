import { useWindowDimensions } from "react-native";
import { makeMutable, runOnUI } from "react-native-reanimated";
import { useScreenLayout } from "../app/screenLayout";
import { deckTurn, type DeckHitCommand } from "../browse/deckTurn";
import { currentTabs, useTabs } from "../tabs/store";
import type { SearchOrigin } from "./store";

export type StandbyPrepared = { generation: number; tabId: string; layout: string; incognito: boolean; origin: SearchOrigin | ""; phone: number };

export type EarlyReveal = { generation: number; press: number; deckTurn: number };

export const NOT_PREPARED: StandbyPrepared = { generation: 0, tabId: "", layout: "", incognito: false, origin: "", phone: -1 };

export const NO_EARLY_REVEAL: EarlyReveal = { generation: 0, press: 0, deckTurn: 0 };

export const PLUS_ORIGIN: SearchOrigin = "page";

const NOT_SHOWN = NO_EARLY_REVEAL;

export const standbyPrepared = makeMutable<StandbyPrepared>(NOT_PREPARED);
export const standbyShownEarly = makeMutable<EarlyReveal>(NOT_SHOWN);
const plusPresses = makeMutable(0);
const deckPlusReveal = makeMutable<EarlyReveal>(NOT_SHOWN);

let lastGeneration = 0;
let preparedOnJS: StandbyPrepared = NOT_PREPARED;
let pressing: EarlyReveal = NOT_SHOWN;
let adopted = 0;
let closedThrough: EarlyReveal = NOT_SHOWN;
let refused: ((generation: number) => void) | null = null;

export const nextStandbyGeneration = () => (lastGeneration += 1);

export function useStandbyLayout(): string {
  const { width, height, fontScale } = useWindowDimensions();
  const name = useScreenLayout((state) => state.layout.name);
  const hinge = useScreenLayout((state) => state.hinge);
  return `${name}|${hinge}|${Math.round(width)}x${Math.round(height)}|${fontScale}`;
}

function showEarly(generation: number, turn: number): EarlyReveal {
  "worklet";
  plusPresses.value += 1;
  const shown = { generation, press: plusPresses.value, deckTurn: turn };
  standbyShownEarly.value = shown;
  return shown;
}

export function revealStandbyOnPress(tabId: string, layout: string, incognito: boolean): EarlyReveal {
  "worklet";
  const prepared = standbyPrepared.value;
  if (prepared.generation === 0 || prepared.origin !== PLUS_ORIGIN || prepared.tabId !== tabId || prepared.layout !== layout || prepared.incognito !== incognito) return NOT_SHOWN;
  return showEarly(prepared.generation, 0);
}

export function deckRevisionIsIncognito(revision: string): boolean {
  "worklet";
  return revision.startsWith("1:");
}

export function revealStandbyFromDeck(hit: DeckHitCommand): EarlyReveal {
  "worklet";
  if (hit.control !== "plus") return NOT_SHOWN;
  const prepared = standbyPrepared.value;
  if (prepared.generation === 0 || prepared.origin !== PLUS_ORIGIN || prepared.tabId !== hit.deck || prepared.phone !== hit.phone) return NOT_SHOWN;
  if (deckTurn.live.value !== hit.turn || deckTurn.phone.value !== hit.phone || prepared.incognito !== deckRevisionIsIncognito(deckTurn.revision.value)) return NOT_SHOWN;
  const shown = showEarly(prepared.generation, hit.turn);
  deckPlusReveal.value = shown;
  return shown;
}

export function shownForGeneration(generation: number, early: EarlyReveal, revealed: number, deckLive: number, deckApplied: number): boolean {
  "worklet";
  if (generation === 0) return false;
  if (revealed === generation) return true;
  if (early.generation !== generation) return false;
  return early.deckTurn === 0 || (deckLive === early.deckTurn && deckApplied !== early.deckTurn);
}

function withdrawOnUI(press: number) {
  "worklet";
  const shown = standbyShownEarly.value;
  if (shown.generation === 0) return;
  if (press === 0 || shown.press === press) standbyShownEarly.value = NOT_SHOWN;
}

function withdrawGenerationOnUI(generation: number) {
  "worklet";
  if (standbyShownEarly.value.generation === generation) standbyShownEarly.value = NOT_SHOWN;
}

export function dropEarlyStandby(press = 0) {
  runOnUI(withdrawOnUI)(press);
}

export function prepareStandby(prepared: StandbyPrepared) {
  adopted = 0;
  closedThrough = NOT_SHOWN;
  preparedOnJS = prepared;
  standbyPrepared.value = prepared;
  dropEarlyStandby();
}

export function unprepareStandby(generation: number) {
  if (preparedOnJS.generation === generation) preparedOnJS = NOT_PREPARED;
  runOnUI((gone: number) => {
    "worklet";
    if (standbyPrepared.value.generation === gone) standbyPrepared.value = NOT_PREPARED;
    withdrawGenerationOnUI(gone);
  })(generation);
}

export const pressedReveal = (): EarlyReveal => pressing;

export function adoptStandby(generation: number) {
  adopted = generation;
}

export const standbyAdopted = (generation: number) => generation !== 0 && adopted === generation;

export function whenPressRefused(hook: ((generation: number) => void) | null) {
  refused = hook;
}

export function refuseEarlyReveal(reveal: EarlyReveal) {
  if (reveal.press === 0) return;
  dropEarlyStandby(reveal.press);
  refused?.(reveal.generation);
}

export function earlyRevealWithdrawn(generation: number) {
  if (generation === 0 || adopted === generation) return;
  refused?.(generation);
}

export function closeEarlyReveal(generation: number) {
  const shown = standbyShownEarly.value;
  if (shown.generation !== generation || shown.press === 0) return;
  if (closedThrough.generation !== generation || closedThrough.press < shown.press) closedThrough = shown;
  dropEarlyStandby(shown.press);
}

const closedBeforeAdoption = (reveal: EarlyReveal) => reveal.press !== 0 && closedThrough.generation === reveal.generation && reveal.press <= closedThrough.press;

export function earlyRevealCurrent(reveal: EarlyReveal): boolean {
  if (reveal.press === 0) return false;
  const prepared = preparedOnJS;
  if (prepared.generation !== reveal.generation || prepared.origin !== PLUS_ORIGIN) return false;
  if (prepared.incognito !== useTabs.getState().incognito || prepared.tabId !== currentTabs().selectedId) return false;
  return reveal.deckTurn === 0 || deckTurn.live.value === reveal.deckTurn;
}

export function pressWithReveal(reveal: EarlyReveal, press: () => void) {
  if (closedBeforeAdoption(reveal)) {
    refuseEarlyReveal(reveal);
    return;
  }
  const current = earlyRevealCurrent(reveal);
  if (!current) refuseEarlyReveal(reveal);
  const taken = current ? reveal : NOT_SHOWN;
  pressing = taken;
  try {
    press();
  } finally {
    pressing = NOT_SHOWN;
    if (adopted !== taken.generation) refuseEarlyReveal(taken);
  }
}

export function pressDeckPlus(turn: number, press: () => void) {
  const reveal = deckPlusReveal.value;
  pressWithReveal(turn !== 0 && reveal.deckTurn === turn ? reveal : NOT_SHOWN, press);
}

export const PRESS_RETENTION = { left: 20, top: 20, right: 20, bottom: 30 } as const;

export function withinPressRect(x: number, y: number, width: number, height: number): boolean {
  "worklet";
  return x >= -PRESS_RETENTION.left && y >= -PRESS_RETENTION.top && x <= width + PRESS_RETENTION.right && y <= height + PRESS_RETENTION.bottom;
}

export type PlusTouch = { live: boolean; pointers: number };

export const IDLE_PLUS_TOUCH: PlusTouch = { live: false, pointers: 0 };

export function plusTouchDown(touch: PlusTouch, pointers: number): PlusTouch {
  "worklet";
  return { live: touch.pointers === 0 ? true : touch.live, pointers };
}

export function plusTouchUp(touch: PlusTouch, pointers: number, x: number, y: number, size: number): { touch: PlusTouch; accepted: boolean } {
  "worklet";
  if (pointers > 0) return { touch: { live: touch.live, pointers }, accepted: false };
  return { touch: IDLE_PLUS_TOUCH, accepted: touch.live && withinPressRect(x, y, size, size) };
}

export const isTouchRelease = (event: unknown): boolean => {
  const native = (event as { nativeEvent?: { changedTouches?: unknown } } | null | undefined)?.nativeEvent;
  return Array.isArray(native?.changedTouches);
};
