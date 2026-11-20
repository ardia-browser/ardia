import { makeMutable, ReduceMotion, runOnJS, runOnUI, withSpring, withTiming } from "react-native-reanimated";
import { create } from "zustand";
import { DECK_PULL, DECK_PULL_SPRING, pullLands, pullShrink, pullSpeed, type PullTarget } from "../../lib/deckPull";

export const PULL_STAGE = { idle: 0, tracking: 1, landing: 2, returning: 3, landed: 4, handed: 5, fading: 6, faded: 7, growing: 8 } as const;

export function pullFades(stage: number): boolean {
  "worklet";
  return stage === PULL_STAGE.fading || stage === PULL_STAGE.faded;
}

export const deckPull = {
  stage: makeMutable<number>(PULL_STAGE.idle),
  id: makeMutable(""),
  shrink: makeMutable(0),
  reveal: makeMutable(0),
  fade: makeMutable(0),
  worstFrame: makeMutable(0),
  pageLive: makeMutable(false),
  barBack: makeMutable(0),
  barCleared: makeMutable(false),
  barOwned: makeMutable(false),
  warm: makeMutable(false),
  steady: makeMutable(false),
  primed: makeMutable(false),
  from: makeMutable(0),
  travel: makeMutable(0),
  target: makeMutable<PullTarget | null>(null),
};

export type PullSettled = (id: string, landed: boolean, worstFrameMs: number) => void;

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
  deckPull.stage.value = PULL_STAGE.idle;
  deckPull.id.value = "";
  deckPull.shrink.value = 0;
  deckPull.reveal.value = 0;
  deckPull.fade.value = 0;
}

export function settleDeckPull(lands: boolean, velocityY: number, settled: PullSettled) {
  "worklet";
  const target = deckPull.target.value;
  const id = deckPull.id.value;
  if (!target || !id) {
    resetDeckPull();
    return;
  }
  const velocity = pullSpeed(velocityY, target.pull);
  if (lands) {
    deckPull.stage.value = PULL_STAGE.landing;
    deckPull.reveal.value = withSpring(1, DECK_PULL_SPRING.reveal);
    deckPull.shrink.value = withSpring(1, { ...DECK_PULL_SPRING.land, velocity }, (finished) => {
      "worklet";
      if (deckPull.stage.value !== PULL_STAGE.landing || deckPull.id.value !== id) return;
      if (!finished) {
        resetDeckPull();
        runOnJS(settled)(id, false, 0);
        return;
      }
      deckPull.stage.value = PULL_STAGE.landed;
      runOnJS(settled)(id, true, deckPull.worstFrame.value);
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
    runOnJS(settled)(id, false, worst);
  });
}

export function abandonDeckPull(id: string, settled: PullSettled) {
  "worklet";
  if (deckPull.stage.value !== PULL_STAGE.tracking || deckPull.id.value !== id) return;
  settleDeckPull(false, 0, settled);
}

export function releaseDeckPull(id: string, velocityY: number, success: boolean, released: (lands: boolean) => void, settled: PullSettled) {
  "worklet";
  if (deckPull.stage.value !== PULL_STAGE.tracking || deckPull.id.value !== id) return;
  const lands = success && pullLands(deckPull.travel.value, velocityY);
  runOnJS(released)(lands);
  settleDeckPull(lands, velocityY, settled);
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

export function landDeckPullFromRest(id: string, settled: PullSettled, refused: (id: string) => void) {
  "worklet";
  if (!beginDeckPull(id, 0)) {
    runOnJS(refused)(id);
    return;
  }
  settleDeckPull(true, 0, settled);
}

export function fadeDeckPullFromRest(id: string, settled: PullSettled, refused: (id: string) => void) {
  "worklet";
  if (!beginDeckPull(id, 0)) {
    runOnJS(refused)(id);
    return;
  }
  deckPull.shrink.value = 1;
  deckPull.reveal.value = 1;
  deckPull.stage.value = PULL_STAGE.fading;
  deckPull.fade.value = withTiming(1, { duration: DECK_PULL.fadeMs, reduceMotion: ReduceMotion.Never }, (finished) => {
    "worklet";
    if (deckPull.stage.value !== PULL_STAGE.fading || deckPull.id.value !== id) return;
    if (!finished) {
      resetDeckPull();
      runOnJS(settled)(id, false, 0);
      return;
    }
    deckPull.stage.value = PULL_STAGE.landed;
    runOnJS(settled)(id, true, deckPull.worstFrame.value);
  });
}

export function cutDeckPullFromRest(id: string, settled: PullSettled, refused: (id: string) => void) {
  "worklet";
  if (!beginDeckPull(id, 0)) {
    runOnJS(refused)(id);
    return;
  }
  deckPull.shrink.value = 1;
  deckPull.reveal.value = 1;
  deckPull.stage.value = PULL_STAGE.landed;
  runOnJS(settled)(id, true, 0);
}

export function handOverDeckPull() {
  "worklet";
  if (deckPull.stage.value === PULL_STAGE.landed || deckPull.stage.value === PULL_STAGE.faded) deckPull.stage.value = PULL_STAGE.handed;
}

export const usePullBar = create<{ deckOwns: boolean }>()(() => ({ deckOwns: false }));

export function setDeckOwnsBar(deckOwns: boolean) {
  if (usePullBar.getState().deckOwns === deckOwns) return;
  usePullBar.setState({ deckOwns });
  deckPull.barOwned.value = deckOwns;
}

function endDeckPullOnUI() {
  "worklet";
  resetDeckPull();
  deckPull.barCleared.value = false;
  deckPull.pageLive.value = false;
  deckPull.barBack.value = 0;
  deckPull.steady.value = false;
  deckPull.primed.value = false;
}

export function endDeckPull() {
  growingId = null;
  grownEnded = null;
  clearTimeout(grownCap);
  runOnUI(endDeckPullOnUI)();
  setDeckOwnsBar(false);
}

let growingId: string | null = null;

export const deckPullGrowing = () => growingId;

function growDeckPullOnUI(target: PullTarget, steady: boolean) {
  "worklet";
  if (deckPull.stage.value !== PULL_STAGE.idle) return;
  deckPull.target.value = target;
  deckPull.id.value = target.id;
  deckPull.shrink.value = 1;
  deckPull.reveal.value = 1;
  deckPull.fade.value = 0;
  deckPull.barBack.value = 0;
  deckPull.pageLive.value = false;
  deckPull.barCleared.value = true;
  deckPull.barOwned.value = true;
  deckPull.steady.value = steady;
  deckPull.stage.value = PULL_STAGE.growing;
  if (steady) return;
  deckPull.reveal.value = withSpring(0, DECK_PULL_SPRING.grow);
  deckPull.shrink.value = withSpring(0, DECK_PULL_SPRING.grow);
}

let grownEnded: ((id: string) => void) | null = null;
let grownCap: ReturnType<typeof setTimeout> | undefined;

export function growDeckPull(target: PullTarget, ended: (id: string) => void, steady = false) {
  growingId = target.id;
  grownEnded = ended;
  setDeckOwnsBar(true);
  runOnUI(growDeckPullOnUI)(target, steady);
}

function growEnded(id: string) {
  clearTimeout(grownCap);
  const ended = grownEnded;
  grownEnded = null;
  if (growingId === id) ended?.(id);
}

export function showGrowingPage(id: string) {
  clearTimeout(grownCap);
  grownCap = setTimeout(() => growEnded(id), DECK_PULL.barBackCapMs);
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
  runOnUI((opened: string, done: (id: string) => void) => {
    "worklet";
    if (deckPull.stage.value !== PULL_STAGE.growing || deckPull.id.value !== opened || !deckPull.pageLive.value) return;
    deckPull.barBack.value = withTiming(1, { duration: DECK_PULL.barBackMs, reduceMotion: ReduceMotion.Never }, () => {
      "worklet";
      runOnJS(done)(opened);
    });
  })(id, growEnded);
}

let standbyId: string | null = null;
let armedId: string | null = null;
let armedFades = false;
let entrance: string | null = null;
const standbyWaiters = new Set<(id: string | null) => void>();

export function publishDeckStandby(target: PullTarget | null) {
  standbyId = target?.id ?? null;
  runOnUI((next: PullTarget | null) => {
    "worklet";
    deckPull.target.value = next;
  })(target);
  for (const waiter of [...standbyWaiters]) waiter(standbyId);
}

export const deckStandbyId = () => standbyId;

export function whenDeckStandby(id: string, then: (ready: boolean) => void): () => void {
  if (standbyId === id) {
    then(true);
    return () => undefined;
  }
  const stop = () => {
    clearTimeout(cap);
    standbyWaiters.delete(waiter);
  };
  const waiter = (now: string | null) => {
    if (now !== id) return;
    stop();
    then(true);
  };
  const cap = setTimeout(() => {
    stop();
    then(false);
  }, DECK_PULL.standbyCapMs);
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

export function noteDeckPullEntrance(id: string | null) {
  entrance = id;
}

export const peekDeckPullEntrance = () => entrance;

export function takeDeckPullEntrance(): boolean {
  const was = entrance !== null;
  entrance = null;
  return was;
}
