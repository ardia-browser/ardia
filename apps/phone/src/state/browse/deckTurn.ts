import { makeMutable, runOnUI } from "react-native-reanimated";
import { create } from "zustand";

export type DeckControl = "more" | "spaces" | "privacy" | "search" | "plus";

export type DeckBounds = { left: number; top: number; right: number; bottom: number };

export type DeckControls = Partial<Record<DeckControl, DeckBounds>>;

export type PreparedDeck = { tabId: string; order: readonly string[]; revision: string; layout: number; phone: number; present: readonly DeckControl[]; controls: DeckControls };

export type DeckPress = { control: DeckControl; turn: number; phone: number; deck: string; bounds: DeckBounds | null };

export type DeckHitCommand = { seq: number; turn: number; phone: number; control: DeckControl | "card"; label: string; deck: string; tabId?: string; posedTurn?: number };

export type DeckCardLift = { turn: number; phone: number; deck: string };

export const DECK_HIT_LABELS = ["more", "spaces", "privacy", "search", "plus", "card"] as const;

export const DECK_PRESS_SLOP = 12;

export const deckTurn = {
  live: makeMutable(0),
  seq: makeMutable(0),
  reconciled: makeMutable(0),
  phone: makeMutable(0),
  prepared: makeMutable<PreparedDeck | null>(null),
  press: makeMutable<DeckPress | null>(null),
  pressed: makeMutable(""),
  hitMark: makeMutable(""),
  chromeTurn: makeMutable(0),
  hitSeq: makeMutable(0),
  commandTurn: makeMutable(0),
  appliedTurn: makeMutable(0),
  layout: makeMutable(0),
  revision: makeMutable(""),
};

export const deckLive = deckTurn.live;

export const deckReconciled = deckTurn.reconciled;

export const deckPressed = deckTurn.pressed;

export const deckHitMark = deckTurn.hitMark;

export const deckChromeTurn = deckTurn.chromeTurn;

export const deckRevisionOf = (incognito: boolean, space: string | null) => `${incognito ? 1 : 0}:${space ?? ""}`;

export function deckOwnsInput(): boolean {
  "worklet";
  return deckTurn.live.value !== 0;
}

export function deckAwaitsEntrance(): boolean {
  "worklet";
  const live = deckTurn.live.value;
  return live !== 0 && deckTurn.reconciled.value !== live;
}

export function deckCommandPending(): boolean {
  "worklet";
  const live = deckTurn.live.value;
  return live !== 0 && deckTurn.commandTurn.value === live && deckTurn.appliedTurn.value !== live;
}

export function deckReadyFor(id: string): boolean {
  "worklet";
  const prepared = deckTurn.prepared.value;
  if (prepared === null || prepared.tabId !== id || prepared.phone !== deckTurn.phone.value || !prepared.order.includes(id)) return false;
  if (prepared.revision !== deckTurn.revision.value) return false;
  for (const control of prepared.present) if (prepared.controls[control] === undefined) return false;
  return true;
}

export function deckControlsCurrent(): boolean {
  "worklet";
  const prepared = deckTurn.prepared.value;
  return prepared !== null && prepared.layout === deckTurn.layout.value;
}

export function deckChromeOwned(live: number, chromeTurn: number, settled: boolean): boolean {
  "worklet";
  return live !== 0 ? chromeTurn === live : settled;
}

export function followDeckChromeOnUI(settled: boolean) {
  "worklet";
  const live = deckTurn.live.value;
  if (live === 0 || deckTurn.reconciled.value !== live) return;
  deckTurn.chromeTurn.value = settled ? live : 0;
}

export function deckCardLift(): DeckCardLift {
  "worklet";
  return { turn: deckTurn.live.value, phone: deckTurn.phone.value, deck: deckTurn.prepared.value?.tabId ?? "" };
}

export function takeDeckTurn(): number {
  "worklet";
  const turn = deckTurn.seq.value + 1;
  deckTurn.seq.value = turn;
  deckTurn.reconciled.value = 0;
  deckTurn.press.value = null;
  deckTurn.pressed.value = "";
  deckTurn.chromeTurn.value = turn;
  deckTurn.live.value = turn;
  return turn;
}

function claimDeckTurnOnUI(settled: boolean) {
  "worklet";
  if (deckTurn.live.value === 0) takeDeckTurn();
  const live = deckTurn.live.value;
  deckTurn.chromeTurn.value = settled ? live : 0;
  deckTurn.reconciled.value = live;
}

export function releaseDeckTurnOnUI(turn: number) {
  "worklet";
  if (turn !== 0 && deckTurn.live.value !== turn) return;
  deckTurn.live.value = 0;
  deckTurn.reconciled.value = 0;
  deckTurn.press.value = null;
  deckTurn.pressed.value = "";
  deckTurn.hitMark.value = "";
  deckTurn.chromeTurn.value = 0;
}

function revokeDeckTurnOnUI(phone: number) {
  "worklet";
  deckTurn.phone.value = phone;
  deckTurn.prepared.value = null;
  releaseDeckTurnOnUI(0);
}

const within = (bounds: DeckBounds, x: number, y: number, slop: number) => {
  "worklet";
  return x >= bounds.left - slop && x <= bounds.right + slop && y >= bounds.top - slop && y <= bounds.bottom + slop;
};

const sameBounds = (a: DeckBounds, b: DeckBounds) => {
  "worklet";
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
};

export function pressDeckControl(control: DeckControl, x: number, y: number): boolean {
  "worklet";
  const prepared = deckTurn.prepared.value;
  if (deckCommandPending() && prepared) {
    deckTurn.press.value = { control, turn: deckTurn.live.value, phone: prepared.phone, deck: prepared.tabId, bounds: null };
    return true;
  }
  const bounds = prepared?.controls[control];
  if (!deckAwaitsEntrance() || !prepared || !bounds || !deckControlsCurrent() || prepared.phone !== deckTurn.phone.value || !within(bounds, x, y, DECK_PRESS_SLOP)) return false;
  deckTurn.press.value = { control, turn: deckTurn.live.value, phone: prepared.phone, deck: prepared.tabId, bounds };
  deckTurn.pressed.value = control;
  deckTurn.hitMark.value = "";
  return true;
}

export function deckPressHolds(control: DeckControl): boolean {
  "worklet";
  return deckTurn.press.value?.control === control;
}

export function dropDeckPress(control: DeckControl) {
  "worklet";
  if (deckTurn.press.value?.control === control) deckTurn.press.value = null;
  if (deckTurn.pressed.value === control) deckTurn.pressed.value = "";
}

export function liftDeckControl(control: DeckControl, x: number, y: number): DeckHitCommand | null {
  "worklet";
  const press = deckTurn.press.value;
  dropDeckPress(control);
  if (!press || press.control !== control || press.bounds === null) return null;
  if (deckTurn.live.value !== press.turn || deckTurn.phone.value !== press.phone) return null;
  const prepared = deckTurn.prepared.value;
  const now = prepared?.controls[control];
  if (!prepared || !now || !deckControlsCurrent() || prepared.tabId !== press.deck || !sameBounds(now, press.bounds) || !within(press.bounds, x, y, DECK_PRESS_SLOP)) return null;
  if (deckTurn.commandTurn.value === press.turn) return null;
  deckTurn.commandTurn.value = press.turn;
  const seq = deckTurn.hitSeq.value + 1;
  deckTurn.hitSeq.value = seq;
  const label = `deck-hit:${control}`;
  deckTurn.hitMark.value = label;
  return { seq, turn: press.turn, phone: press.phone, control, label, deck: press.deck };
}

export function takeDeckCardHit(): boolean {
  "worklet";
  const live = deckTurn.live.value;
  if (deckCommandPending()) return false;
  if (!deckAwaitsEntrance()) return true;
  if (deckTurn.commandTurn.value === live) return false;
  deckTurn.commandTurn.value = live;
  deckTurn.hitMark.value = "deck-hit:card";
  return true;
}

export function claimDeckSearchFocus(): DeckHitCommand | "refused" | null {
  "worklet";
  if (deckCommandPending()) return "refused";
  if (!deckAwaitsEntrance()) return null;
  const live = deckTurn.live.value;
  const prepared = deckTurn.prepared.value;
  if (deckTurn.commandTurn.value === live || prepared === null) return "refused";
  deckTurn.commandTurn.value = live;
  const seq = deckTurn.hitSeq.value + 1;
  deckTurn.hitSeq.value = seq;
  deckTurn.hitMark.value = "deck-hit:search";
  return { seq, turn: live, phone: deckTurn.phone.value, control: "search", label: "deck-hit:search", deck: prepared.tabId };
}

export function settleDeckCommand(turn: number) {
  if (turn !== 0) deckTurn.appliedTurn.value = turn;
}

let phoneGeneration = 0;

export const usePhoneTurn = create<{ generation: number }>()(() => ({ generation: 0 }));

export const currentPhoneGeneration = () => phoneGeneration;

export function advancePhoneGeneration(): number {
  phoneGeneration += 1;
  const generation = phoneGeneration;
  runOnUI(revokeDeckTurnOnUI)(generation);
  usePhoneTurn.setState({ generation });
  return generation;
}

type PreparedBase = { tabId: string; order: readonly string[]; revision: string };

let preparedBase: PreparedBase | null = null;
let preparedControls: DeckControls = {};
let presentControls: DeckControl[] = [];
let layoutSeq = 0;
let publishedPhone = -1;

export function prepareDeck(base: PreparedBase | null) {
  const same = base !== null && preparedBase !== null && publishedPhone === phoneGeneration && base.tabId === preparedBase.tabId && base.revision === preparedBase.revision && base.order.length === preparedBase.order.length && base.order.every((id, at) => id === preparedBase!.order[at]);
  if (same) return;
  preparedBase = base;
  wantLayout();
  publishPrepared();
}

function wantLayout() {
  layoutSeq += 1;
  deckTurn.layout.value = layoutSeq;
}

export function deckGeometryChanged() {
  wantLayout();
  requestAnimationFrame(() => {
    if (preparedBase) publishPrepared();
  });
}

function publishSoon() {
  wantLayout();
  publishPrepared();
}

export function presentDeckControl(control: DeckControl, present: boolean) {
  if (presentControls.includes(control) === present) return;
  presentControls = present ? [...presentControls, control] : presentControls.filter((each) => each !== control);
  publishSoon();
}

export function noteDeckRevision(revision: string) {
  deckTurn.revision.value = revision;
}

export function placeDeckControl(control: DeckControl, bounds: DeckBounds | null) {
  const was = preparedControls[control];
  if (bounds === null ? was === undefined : was !== undefined && sameRect(was, bounds)) return;
  const next = { ...preparedControls };
  if (bounds === null) delete next[control];
  else next[control] = bounds;
  preparedControls = next;
  publishSoon();
}

const sameRect = (a: DeckBounds, b: DeckBounds) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

function publishPrepared() {
  const base = preparedBase;
  publishedPhone = phoneGeneration;
  const prepared: PreparedDeck | null = base ? { ...base, order: [...base.order], layout: layoutSeq, phone: phoneGeneration, present: [...presentControls], controls: { ...preparedControls } } : null;
  runOnUI((next: PreparedDeck | null) => {
    "worklet";
    deckTurn.prepared.value = next;
  })(prepared);
}

export function forgetPreparedDeck() {
  preparedBase = null;
  preparedControls = {};
  presentControls = [];
  wantLayout();
  publishPrepared();
}

export const useDeckHits = create<{ hit: DeckHitCommand | null }>()(() => ({ hit: null }));

const consumedHits = new Set<number>();

let commandedTurn = 0;

export const deckHitLive = (hit: DeckHitCommand) => hit.turn !== 0 && hit.turn !== commandedTurn && hit.turn === deckTurn.live.value && !consumedHits.has(hit.seq);

export function queueDeckHit(hit: DeckHitCommand) {
  if (consumedHits.has(hit.seq) || hit.turn === 0 || hit.turn === commandedTurn || hit.turn !== deckTurn.live.value) return false;
  commandedTurn = hit.turn;
  useDeckHits.setState({ hit });
  return true;
}

export function takeDeckHit(hit: DeckHitCommand): boolean {
  if (useDeckHits.getState().hit === hit) useDeckHits.setState({ hit: null });
  if (consumedHits.has(hit.seq) || hit.phone !== phoneGeneration || hit.turn !== deckTurn.live.value) return false;
  consumedHits.add(hit.seq);
  return true;
}

export const peekDeckHit = () => useDeckHits.getState().hit;

export function dropDeckHits() {
  if (useDeckHits.getState().hit) useDeckHits.setState({ hit: null });
}

let cardHits = 0;

export function cardHitSeq() {
  cardHits -= 1;
  return cardHits;
}

let reconciledTurn = 0;

export const deckTurnReconciled = (turn: number) => turn !== 0 && turn === reconciledTurn;

export function noteDeckTurnReconciled(turn: number) {
  reconciledTurn = turn;
}

export function markDeckEntranceCommitted(turn: number, settled: boolean) {
  runOnUI((committed: number, settles: boolean) => {
    "worklet";
    if (committed === 0) {
      claimDeckTurnOnUI(settles);
      return;
    }
    if (deckTurn.live.value !== committed) return;
    if (settles) deckTurn.chromeTurn.value = committed;
    deckTurn.reconciled.value = committed;
  })(turn, settled);
}

export function deckLiftCurrent(lift: DeckCardLift): boolean {
  return lift.phone === phoneGeneration && lift.turn === deckTurn.live.value;
}
