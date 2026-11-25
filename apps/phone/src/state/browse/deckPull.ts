import { cancelAnimation, makeMutable, ReduceMotion, runOnJS, runOnUI, withSpring, withTiming } from "react-native-reanimated";
import { create } from "zustand";
import { labTrace } from "../../platform/lab";
import { DECK_PULL, DECK_PULL_SPRING, deckCardAt, landingVelocity, pullLands, pullShrink, pullSpeed, type DeckHit, type PullTarget } from "../../lib/deckPull";
import { deckReadyFor, deckTurn, releaseDeckTurnOnUI, takeDeckTurn } from "./deckTurn";

export const PULL_STAGE = { idle: 0, tracking: 1, landing: 2, returning: 3, landed: 4, handed: 5, fading: 6, faded: 7, growing: 8 } as const;

export function pullFades(stage: number): boolean {
  "worklet";
  return stage === PULL_STAGE.fading || stage === PULL_STAGE.faded;
}

export const pageBarShown = makeMutable(1);

export const pageBodyShown = makeMutable(1);

export const pageBarPreviewShown = makeMutable(0);

export const deckPull = {
  stage: makeMutable<number>(PULL_STAGE.idle),
  id: makeMutable(""),
  shrink: makeMutable(0),
  reveal: makeMutable(0),
  fade: makeMutable(0),
  worstFrame: makeMutable(0),
  pageLive: makeMutable(false),
  awayId: makeMutable(""),
  barBack: makeMutable(0),
  barCleared: makeMutable(false),
  barOwned: makeMutable(false),
  barTurn: makeMutable(0),
  cut: makeMutable(false),
  warm: makeMutable(false),
  steady: makeMutable(false),
  primed: makeMutable(false),
  from: makeMutable(0),
  travel: makeMutable(0),
  target: makeMutable<PullTarget | null>(null),
  hit: makeMutable<DeckHit | null>(null),
  landing: makeMutable(0),
  openAfter: makeMutable(""),
  hitTurn: makeMutable(0),
  landingPhone: makeMutable(0),
};

export type PullSettled = (id: string, landed: boolean, worstFrameMs: number, openAfter: string, turn: number, phone: number) => void;

export type PullRefused = (id: string, phone: number) => void;

export function deckCutOwns(): boolean {
  "worklet";
  return deckPull.cut.value && deckTurn.live.value !== 0;
}

function showPageOnUI() {
  "worklet";
  pageBarShown.value = 1;
  pageBodyShown.value = 1;
  pageBarPreviewShown.value = 0;
}


function watchPullFrames() {
  "worklet";
  deckPull.worstFrame.value = 0;
  let last = -1;
  const step = (now: number) => {
    const stage = deckPull.stage.value;
    if (stage !== PULL_STAGE.tracking && stage !== PULL_STAGE.landing && stage !== PULL_STAGE.returning && stage !== PULL_STAGE.fading) return;
    if (last >= 0 && now - last > deckPull.worstFrame.value) deckPull.worstFrame.value = now - last;
    last = now;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function beginDeckPull(id: string, at: number): boolean {
  "worklet";
  const target = deckPull.target.value;
  if (deckPull.stage.value !== PULL_STAGE.idle || !target || target.id !== id) return false;
  deckPull.id.value = id;
  deckPull.awayId.value = "";
  deckPull.from.value = at;
  deckPull.travel.value = 0;
  deckPull.shrink.value = 0;
  deckPull.reveal.value = 0;
  deckPull.fade.value = 0;
  deckPull.stage.value = PULL_STAGE.tracking;
  watchPullFrames();
  return true;
}

export function trackDeckPull(at: number) {
  "worklet";
  const target = deckPull.target.value;
  if (deckPull.stage.value !== PULL_STAGE.tracking || !target) return;
  deckPull.travel.value = deckPull.from.value - at;
  deckPull.shrink.value = withSpring(pullShrink(deckPull.travel.value, target.pull), DECK_PULL_SPRING.follow);
}

export function resetDeckPull() {
  "worklet";
  deckPull.cut.value = false;
  deckPull.stage.value = PULL_STAGE.idle;
  deckPull.id.value = "";
  deckPull.shrink.value = 0;
  deckPull.reveal.value = 0;
  deckPull.fade.value = 0;
  deckPull.openAfter.value = "";
}

export function handOverDeckPull() {
  "worklet";
  if (deckPull.stage.value !== PULL_STAGE.landed && deckPull.stage.value !== PULL_STAGE.faded) return;
  deckPull.awayId.value = deckPull.id.value;
  deckPull.stage.value = PULL_STAGE.handed;
}

function ownDeckAtCut(id: string): number {
  "worklet";
  deckPull.cut.value = true;
  pageBarShown.value = 0;
  pageBodyShown.value = 0;
  cancelAnimation(deckPull.shrink);
  cancelAnimation(deckPull.reveal);
  deckPull.shrink.value = 1;
  deckPull.reveal.value = 1;
  deckPull.id.value = id;
  deckPull.stage.value = PULL_STAGE.landed;
  handOverDeckPull();
  return takeDeckTurn();
}

function landingEnded(id: string, landing: number, finished: boolean | undefined, settled: PullSettled) {
  "worklet";
  if (deckPull.stage.value !== PULL_STAGE.landing || deckPull.id.value !== id || deckPull.landing.value !== landing) return;
  if (!finished) {
    resetDeckPull();
    runOnJS(settled)(id, false, 0, "", 0, deckPull.landingPhone.value);
    return;
  }
  const openAfter = deckPull.openAfter.value;
  deckPull.openAfter.value = "";
  deckPull.stage.value = PULL_STAGE.landed;
  handOverDeckPull();
  runOnJS(settled)(id, true, deckPull.worstFrame.value, openAfter, 0, deckPull.landingPhone.value);
}

export function hurryDeckPull(x: number, y: number, settled: PullSettled): boolean {
  "worklet";
  const id = deckPull.id.value;
  if (deckPull.stage.value !== PULL_STAGE.landing || !id) return false;
  const hit = deckPull.hit.value;
  const tapped = hit ? deckCardAt(hit, x, y) : null;
  if (deckPull.openAfter.value !== "" || !tapped) return false;
  deckPull.openAfter.value = tapped;
  const landing = deckPull.landing.value + 1;
  deckPull.landing.value = landing;
  deckPull.reveal.value = withSpring(DECK_PULL.hurryLanding, DECK_PULL_SPRING.hurry);
  deckPull.shrink.value = withSpring(DECK_PULL.hurryLanding, DECK_PULL_SPRING.hurry, (finished) => {
    "worklet";
    landingEnded(id, landing, finished, settled);
  });
  return true;
}

export function settleDeckPull(lands: boolean, velocityY: number, settled: PullSettled, cuts = false) {
  "worklet";
  const target = deckPull.target.value;
  const id = deckPull.id.value;
  if (!target || !id) {
    resetDeckPull();
    return;
  }
  const velocity = pullSpeed(velocityY, target.pull);
  deckPull.landingPhone.value = deckTurn.phone.value;
  if (lands && cuts && deckReadyFor(id)) {
    const worst = deckPull.worstFrame.value;
    const turn = ownDeckAtCut(id);
    runOnJS(settled)(id, true, worst, "", turn, deckTurn.phone.value);
    return;
  }
  if (lands) {
    deckPull.stage.value = PULL_STAGE.landing;
    const landing = deckPull.landing.value + 1;
    deckPull.landing.value = landing;
    cancelAnimation(deckPull.shrink);
    deckPull.reveal.value = withSpring(1, DECK_PULL_SPRING.land);
    deckPull.shrink.value = withSpring(1, { ...DECK_PULL_SPRING.land, velocity: landingVelocity(deckPull.shrink.value, velocity) }, (finished) => {
      "worklet";
      landingEnded(id, landing, finished, settled);
    });
    return;
  }
  deckPull.stage.value = PULL_STAGE.returning;
  deckPull.reveal.value = withSpring(0, DECK_PULL_SPRING.back);
  deckPull.shrink.value = withSpring(0, { ...DECK_PULL_SPRING.back, velocity }, (finished) => {
    "worklet";
    if (deckPull.stage.value !== PULL_STAGE.returning || deckPull.id.value !== id) return;
    const worst = finished ? deckPull.worstFrame.value : 0;
    resetDeckPull();
    runOnJS(settled)(id, false, worst, "", 0, deckPull.landingPhone.value);
  });
}

export function abandonDeckPull(id: string, settled: PullSettled) {
  "worklet";
  if (deckPull.stage.value !== PULL_STAGE.tracking || deckPull.id.value !== id) return;
  settleDeckPull(false, 0, settled);
}

export function releaseDeckPull(id: string, velocityY: number, success: boolean, released: (lands: boolean) => void, settled: PullSettled, cuts = false) {
  "worklet";
  if (deckPull.stage.value !== PULL_STAGE.tracking || deckPull.id.value !== id) return;
  const lands = success && pullLands(deckPull.travel.value, velocityY);
  runOnJS(released)(lands);
  settleDeckPull(lands, velocityY, settled, cuts);
}

export type PullPath = { travel: number; ms: number; velocityY: number };

export function replayDeckPull(id: string, path: PullPath, began: () => void, released: (lands: boolean) => void, settled: PullSettled, refused: () => void) {
  "worklet";
  if (!beginDeckPull(id, 0)) {
    runOnJS(refused)();
    return;
  }
  runOnJS(began)();
  let first = -1;
  const step = (now: number) => {
    if (deckPull.stage.value !== PULL_STAGE.tracking || deckPull.id.value !== id) return;
    if (first < 0) first = now;
    const along = Math.min((now - first) / path.ms, 1);
    trackDeckPull(-path.travel * along);
    if (along < 1) requestAnimationFrame(step);
    else releaseDeckPull(id, path.velocityY, true, released, settled);
  };
  requestAnimationFrame(step);
}

export function landDeckPullFromRest(id: string, settled: PullSettled, refused: PullRefused) {
  "worklet";
  const phone = deckTurn.phone.value;
  if (!beginDeckPull(id, 0)) {
    runOnJS(refused)(id, phone);
    return;
  }
  settleDeckPull(true, 0, settled);
}

export function fadeDeckPullFromRest(id: string, settled: PullSettled, refused: PullRefused) {
  "worklet";
  const phone = deckTurn.phone.value;
  if (!beginDeckPull(id, 0)) {
    runOnJS(refused)(id, phone);
    return;
  }
  deckPull.landingPhone.value = phone;
  deckPull.shrink.value = 1;
  deckPull.reveal.value = 1;
  deckPull.stage.value = PULL_STAGE.fading;
  deckPull.fade.value = withTiming(1, { duration: DECK_PULL.fadeMs, reduceMotion: ReduceMotion.Never }, (finished) => {
    "worklet";
    if (deckPull.stage.value !== PULL_STAGE.fading || deckPull.id.value !== id) return;
    if (!finished) {
      resetDeckPull();
      runOnJS(settled)(id, false, 0, "", 0, phone);
      return;
    }
    deckPull.stage.value = PULL_STAGE.faded;
    handOverDeckPull();
    runOnJS(settled)(id, true, deckPull.worstFrame.value, "", 0, phone);
  });
}

export function cutDeckPullFromRest(id: string, settled: PullSettled, refused: PullRefused) {
  "worklet";
  const phone = deckTurn.phone.value;
  if (!deckReadyFor(id) || !beginDeckPull(id, 0)) {
    runOnJS(refused)(id, phone);
    return;
  }
  const turn = ownDeckAtCut(id);
  runOnJS(settled)(id, true, 0, "", turn, phone);
}

export function releaseDeckOnHideOnUI() {
  "worklet";
  if (deckPull.cut.value && deckPull.stage.value !== PULL_STAGE.idle) return;
  releaseDeckTurnOnUI(0);
}

export function restorePageAfterRefusedCut(turn: number) {
  runOnUI((refused: number) => {
    "worklet";
    if (refused !== 0 && deckTurn.live.value !== refused) return;
    releaseDeckTurnOnUI(refused);
    resetDeckPull();
    showPageOnUI();
  })(turn);
}

export const usePullBar = create<{ deckOwns: boolean }>()(() => ({ deckOwns: false }));


export const usePageBarPreview = create<{ id: string | null }>()(() => ({ id: null }));

export function previewPageBar(id: string | null) {
  if (usePageBarPreview.getState().id !== id) usePageBarPreview.setState({ id });
}

export function setDeckOwnsBar(deckOwns: boolean) {
  if (usePullBar.getState().deckOwns === deckOwns) return;
  usePullBar.setState({ deckOwns });
  deckPull.barOwned.value = deckOwns;
}

let barTurn = 0;

function handDeckBar(deckOwns: boolean): number {
  barTurn += 1;
  deckPull.barTurn.value = barTurn;
  setDeckOwnsBar(deckOwns);
  return barTurn;
}

export function reportDeckOwnsBar(deckOwns: boolean, turn: number) {
  if (turn !== barTurn) return;
  setDeckOwnsBar(deckOwns);
}

function endDeckPullOnUI(turn: number) {
  "worklet";
  resetDeckPull();
  deckPull.barCleared.value = false;
  runOnJS(reportDeckOwnsBar)(false, turn);
  deckPull.pageLive.value = false;
  deckPull.barBack.value = 0;
  deckPull.steady.value = false;
  deckPull.primed.value = false;
}

export function showPulledPage() {
  runOnUI(() => {
    "worklet";
    deckPull.awayId.value = "";
  })();
}

export function endDeckPull() {
  growingId = null;
  grownLanded = null;
  growSeq += 1;
  grownEnded = null;
  clearTimeout(grownCap);
  runOnUI(endDeckPullOnUI)(handDeckBar(false));
}

let growingId: string | null = null;
let growSeq = 0;

export const deckPullGrowing = () => growingId;

export function pullCanGrow(stage: number): boolean {
  "worklet";
  return stage === PULL_STAGE.idle || stage === PULL_STAGE.landed || stage === PULL_STAGE.faded || stage === PULL_STAGE.handed;
}

const traceGrow = (line: string) => labTrace(`PAGELAB card grow ${line}`);

function growDeckPullOnUI(target: PullTarget, steady: boolean, seq: number, grown: (id: string, seq: number) => void) {
  "worklet";
  if (!pullCanGrow(deckPull.stage.value)) {
    runOnJS(traceGrow)(`refused at stage ${deckPull.stage.value}`);
    runOnJS(grown)(target.id, seq);
    return;
  }
  deckPull.target.value = target;
  deckPull.id.value = target.id;
  deckPull.awayId.value = "";
  deckPull.shrink.value = 1;
  deckPull.reveal.value = 1;
  deckPull.fade.value = 0;
  deckPull.barBack.value = 0;
  deckPull.pageLive.value = false;
  deckPull.barCleared.value = true;
  deckPull.barOwned.value = true;
  deckPull.steady.value = steady;
  deckPull.stage.value = PULL_STAGE.growing;
  if (steady) {
    runOnJS(grown)(target.id, seq);
    return;
  }
  deckPull.reveal.value = withSpring(0, DECK_PULL_SPRING.grow);
  deckPull.shrink.value = withSpring(0, DECK_PULL_SPRING.grow, (finished) => {
    "worklet";
    if (finished && deckPull.stage.value === PULL_STAGE.growing && deckPull.id.value === target.id) runOnJS(grown)(target.id, seq);
    else runOnJS(traceGrow)(`ended without landing: finished ${finished}, stage ${deckPull.stage.value}`);
  });
}

let grownEnded: ((id: string) => void) | null = null;
let grownLanded: ((id: string) => void) | null = null;
let grownCap: ReturnType<typeof setTimeout> | undefined;

function growLanded(id: string, seq: number) {
  if (seq !== growSeq || growingId !== id) return;
  const landed = grownLanded;
  grownLanded = null;
  landed?.(id);
}

export function growDeckPull(target: PullTarget, ended: (id: string) => void, grown: (id: string) => void, steady = false): boolean {
  if (growingId !== null) return false;
  growingId = target.id;
  growSeq += 1;
  grownEnded = ended;
  grownLanded = grown;
  handDeckBar(true);
  runOnUI(growDeckPullOnUI)(target, steady, growSeq, growLanded);
  return true;
}

function growEnded(id: string, seq: number) {
  if (seq !== growSeq || growingId !== id) return;
  clearTimeout(grownCap);
  const ended = grownEnded;
  grownEnded = null;
  ended?.(id);
}

export function showGrowingPage(id: string) {
  clearTimeout(grownCap);
  const seq = growSeq;
  grownCap = setTimeout(() => growEnded(id, seq), DECK_PULL.barBackCapMs);
  runOnUI((opened: string) => {
    "worklet";
    if (deckPull.stage.value !== PULL_STAGE.growing || deckPull.id.value !== opened) return;
    if (deckPull.steady.value) {
      deckPull.fade.value = 0;
      deckPull.fade.value = withTiming(1, { duration: DECK_PULL.fadeMs, reduceMotion: ReduceMotion.Never });
    }
    deckPull.shrink.value = 0;
    deckPull.pageLive.value = true;
  })(id);
}

export function barReturnedToPage() {
  const id = growingId;
  if (!id) return;
  runOnUI((opened: string, seq: number, done: (id: string, seq: number) => void) => {
    "worklet";
    if (deckPull.stage.value !== PULL_STAGE.growing || deckPull.id.value !== opened || !deckPull.pageLive.value) return;
    deckPull.barBack.value = withTiming(1, { duration: DECK_PULL.barBackMs, reduceMotion: ReduceMotion.Never }, () => {
      "worklet";
      runOnJS(done)(opened, seq);
    });
  })(id, growSeq, growEnded);
}

let standbyId: string | null = null;
let armedId: string | null = null;
let armedFades = false;
export type DeckPullEntrance = { id: string; turn: number; phone: number };

let entrance: DeckPullEntrance | null = null;
const standbyWaiters = new Set<(id: string | null) => void>();

export function publishDeckStandby(target: PullTarget | null, hit: DeckHit | null = null) {
  standbyId = target?.id ?? null;
  runOnUI((next: PullTarget | null, cards: DeckHit | null) => {
    "worklet";
    deckPull.target.value = next;
    deckPull.hit.value = next ? cards : null;
    deckPull.hitTurn.value += 1;
  })(target, hit);
  for (const waiter of [...standbyWaiters]) waiter(standbyId);
}

export const deckStandbyId = () => standbyId;

export function whenDeckStandby(id: string, then: (ready: boolean) => void): () => void {
  if (standbyId === id) {
    then(true);
    return () => undefined;
  }
  const stop = () => {
    cancelAnimationFrame(frame);
    standbyWaiters.delete(waiter);
  };
  const waiter = (now: string | null) => {
    if (now !== id) return;
    stop();
    then(true);
  };
  const frame = requestAnimationFrame(() => {
    stop();
    then(standbyId === id);
  });
  standbyWaiters.add(waiter);
  return stop;
}

export function armDeckPull(id: string | null, fades = false) {
  armedId = id;
  armedFades = fades;
}

export const deckPullFades = () => armedFades;

export function disarmDeckPull(id: string, settled: PullSettled) {
  if (armedId === id) armedId = null;
  runOnUI(abandonDeckPull)(id, settled);
}

export const deckPullArmed = () => armedId;

export function noteDeckPullEntrance(next: DeckPullEntrance | null) {
  entrance = next;
}

export const peekDeckPullEntrance = () => entrance;

export function takeDeckPullEntrance(): DeckPullEntrance | null {
  const was = entrance;
  entrance = null;
  return was;
}
