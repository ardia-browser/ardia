import { createElement } from "react";
import { AccessibilityInfo } from "react-native";
import type { NativeSwipeAreaProps, SwipeModule } from "@ardia/ardiacore";
import { requireNativeModule } from "../modules";
import type { PagerStateEvent } from "../pager/pager";
import { viewNamed } from "../views/registry";
import { expectEqual, expectTrue, type Check } from "./check";
import { holdOnStage } from "./stage";


const swipe = () => requireNativeModule<Pick<SwipeModule, "switchPager" | "stepPager" | "selectPager" | "leadPager" | "pagerState">>("ArdiaSwipe");
const settled = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ORDER = ["self-check-a", "self-check-b", "self-check-c"];
const SETTLE_LIMIT_MS = 3000;
const MIN_FRAMES = 5;

let pagerCount = 0;

async function animationsOff() {
  try {
    return await AccessibilityInfo.isReduceMotionEnabled();
  } catch {
    return false;
  }
}

async function staged(key: string, leading = false) {
  const positions: number[] = [];
  const states: PagerStateEvent[] = [];
  const release = await holdOnStage(
    createElement(viewNamed<NativeSwipeAreaProps>("ArdiaSwipe"), {
      style: { width: 200, height: 40 },
      canSwipeBack: false,
      canSwipeForward: true,
      nativePager: { key, selected: 0, count: ORDER.length, ack: 0, width: 200, order: ORDER, leading, library: false },
      onSwipe: () => {},
      onPagerPosition: (event: { nativeEvent: { position: number; leading: number } }) => positions.push(event.nativeEvent.position),
      onPagerState: (event: { nativeEvent: PagerStateEvent }) => states.push(event.nativeEvent),
    }),
    "ArdiaSwipe with a pager",
  );
  return { positions, states, release };
}

async function until(condition: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !condition()) await settled(20);
  return condition();
}

async function settledAfter(states: PagerStateEvent[], from: number) {
  const rested = await until(() => states.slice(from).some((state) => state.phase === "settled"), SETTLE_LIMIT_MS);
  expectTrue(rested, `no settled state within ${SETTLE_LIMIT_MS} ms`);
  return states.slice(from);
}

const pick = (key: string) => {
  const state = swipe().pagerState(key);
  return [state?.selected, state?.position, state?.leading, state?.lead, state?.profileId];
};

export const checks: Check[] = [
  {
    name: "the profile pager is refused for a key with no view",
    async run() {
      expectEqual(await swipe().switchPager("self-check-no-pager", 1, ORDER), false, "switchPager");
      expectEqual(await swipe().stepPager("self-check-no-pager", 1, false, ORDER), false, "stepPager");
      expectEqual(swipe().pagerState("self-check-no-pager"), null, "pagerState");
    },
  },
  {
    name: "the profile pager slides to a page and reports the settle",
    async run() {
      const key = `self-check-pager-${++pagerCount}`;
      const off = await animationsOff();
      const { positions, states, release } = await staged(key);
      try {
        const before = swipe().pagerState(key);
        expectTrue(before, "the mounted view made no pager");
        expectEqual([before.selected, before.position, before.phase, before.profileId], [0, 0, "idle", ORDER[0]], "the pager before the switch");
        const start = positions.length;
        const mark = states.length;
        expectEqual(await swipe().switchPager(key, 2, ORDER), true, "switchPager");
        const rested = await until(() => states.some((state) => state.phase === "settled"), SETTLE_LIMIT_MS);
        expectTrue(rested, `no settled state within ${SETTLE_LIMIT_MS} ms, positions ${JSON.stringify(positions.slice(start))}`);
        const moved = positions.slice(start);
        expectEqual(moved[moved.length - 1], 2, "the last position");
        if (off) {
          console.info("[ardia windows] self-check: animations are off, so the pager jumped");
        } else {
          expectTrue(moved.length >= MIN_FRAMES, `only ${moved.length} position frames: ${JSON.stringify(moved)}`);
          for (let i = 1; i < moved.length; i += 1) {
            expectTrue(moved[i]! >= moved[i - 1]! && moved[i]! <= 2, `position went the wrong way at frame ${i}: ${JSON.stringify(moved)}`);
          }
        }
        const selected = states.slice(mark).find((state) => state.phase === "selected");
        const done = states.slice(mark).find((state) => state.phase === "settled")!;
        expectTrue(selected, "no selected state");
        expectTrue(selected.sequence > before.sequence && done.sequence > selected.sequence, `sequences ${before.sequence}, ${selected.sequence}, ${done.sequence}`);
        expectEqual([done.selected, done.position, done.profileId], [2, 2, ORDER[2]], "the settled state");
        const after = swipe().pagerState(key);
        expectEqual([after?.sequence, after?.phase, after?.selected], [done.sequence, "idle", 2], "the pager after the settle");
        expectEqual(await swipe().stepPager(key, 1, false, ORDER), true, "a step past the last page");
        expectEqual(swipe().pagerState(key)?.sequence, done.sequence, "a step past the last page moved the pager");
      } finally {
        release();
      }
      await until(() => swipe().pagerState(key) === null, 1000);
      expectEqual(swipe().pagerState(key), null, "the pager after its view unmounted");
    },
  },
  {
    name: "the profile pager opens the Library page before the first profile and closes onto the chosen one",
    async run() {
      const key = `self-check-pager-${++pagerCount}`;
      const { states, release } = await staged(key, true);
      try {
        let mark = states.length;
        expectEqual(await swipe().stepPager(key, -1, false, ORDER), true, "a step back from the first profile");
        const opened = await settledAfter(states, mark);
        const selected = opened.find((state) => state.phase === "selected");
        expectEqual([selected?.selected, selected?.leading, selected?.profileId], [-1, true, null], "the Library's selected state");
        expectEqual(pick(key), [-1, -1, true, 1, null], "the pager at the Library");
        expectEqual(await swipe().selectPager(key, ORDER[2]!, ORDER), true, "selectPager at the Library");
        expectEqual(pick(key), [-1, 1, true, 1, null], "the Library re-anchored over the selected profile");
        mark = states.length;
        expectEqual(await swipe().switchPager(key, 1, ORDER), true, "switchPager at the Library");
        const closed = await settledAfter(states, mark);
        const done = closed.find((state) => state.phase === "settled");
        expectEqual([done?.selected, done?.leading, done?.profileId], [1, false, ORDER[1]], "the settle after closing the Library");
        mark = states.length;
        expectEqual(await swipe().leadPager(key, true, true), true, "leadPager open");
        await settledAfter(states, mark);
        expectEqual(pick(key), [-1, 0, true, 1, null], "the Library opened from the second profile");
        mark = states.length;
        expectEqual(await swipe().leadPager(key, false, true), true, "leadPager close");
        await settledAfter(states, mark);
        expectEqual(pick(key), [1, 1, false, 0, ORDER[1]], "the pager after closing the Library");
        mark = states.length;
        expectEqual(await swipe().leadPager(key, true, true), true, "leadPager reopen");
        await settledAfter(states, mark);
        expectEqual(await swipe().leadPager(key, false, false), true, "leadPager close without animation");
        expectEqual(pick(key), [1, 1, false, 0, ORDER[1]], "the pager right after closing without animation");
        expectEqual(swipe().pagerState(key)?.phase, "idle", "the phase after closing without animation");
      } finally {
        release();
      }
      const plain = `self-check-pager-${++pagerCount}`;
      const { release: releasePlain } = await staged(plain);
      try {
        expectEqual(await swipe().leadPager(plain, true, true), false, "leadPager on a pager without a Library page");
        expectEqual(pick(plain), [0, 0, false, 0, ORDER[0]], "the pager without a Library page");
      } finally {
        releasePlain();
      }
    },
  },
];
