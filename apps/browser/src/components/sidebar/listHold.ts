import { useEffect, useRef, useState } from "react";
import { Animated } from "react-native";
import { sidebarNow, sidebarTabClosedSince, type SidebarSnapshot } from "../../state/sidebar/hooks";
import { consentToken, type ConsentToken } from "../../state/telemetry/client";
import { noteSidebarListHeld } from "../../state/telemetry/sidebarScrollCounts";
import { curve } from "../ui/motion";
import { reduceMotion } from "../ui/reduceMotion";
import { SIDEBAR_MOTION } from "./tokens";

export type ListHold = {
  minHeight: Animated.Value;
  holding: () => boolean;
  enter: () => void;
  leave: () => void;
  reset: () => void;
  measured: (content: number) => void;
  laidOut: () => void;
  resized: () => void;
};

export type HoldPage = {
  windowId: string;
  profileId: string;
  active: boolean;
  free: () => number;
  viewport: () => number;
  docked: () => boolean;
  dockingAfter: (free: number) => boolean;
  dock: (docked: boolean) => void;
  undockRoom: () => number;
};

export const LAYOUT_WAIT_MS = 100;
const SETTLED = 0.5;

export function createListHold(page: () => HoldPage): ListHold {
  const minHeight = new Animated.Value(0);
  let floor = 0;
  let content = 0;
  let lastFree = 0;
  let layouts = 0;
  let pointerIn = false;
  let holding = false;
  let undocked = false;
  let run = 0;
  let waiting: { ready: () => boolean; go: (laidOut: boolean) => void } | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let counted = false;
  let consent: ConsentToken | null = null;
  let seen: SidebarSnapshot | null = null;
  let laid: SidebarSnapshot = sidebarNow();

  const setFloor = (value: number) => {
    if (value === floor) return;
    floor = value;
    minHeight.setValue(value);
  };
  const stopWaiting = () => {
    clearTimeout(waitTimer);
    waiting = null;
  };
  const stop = () => {
    run++;
    stopWaiting();
    minHeight.stopAnimation((value) => (floor = value));
  };
  const after = (ready: () => boolean, then: (laidOut: boolean) => void) => {
    const entry = {
      ready,
      go: (laidOut: boolean) => {
        if (waiting !== entry) return;
        stopWaiting();
        then(laidOut);
      },
    };
    waiting = entry;
    waitTimer = setTimeout(() => entry.go(false), LAYOUT_WAIT_MS);
  };
  const wake = () => {
    if (waiting?.ready()) waiting.go(true);
  };
  const closePending = () => sidebarTabClosedSince(laid, page().windowId, page().profileId);
  const nextLayout = (then: () => void) => {
    const mark = layouts;
    after(
      () => layouts > mark,
      (laidOut) => {
        if (!laidOut) laid = sidebarNow();
        then();
      },
    );
  };
  const settledLength = () => Math.max(page().viewport(), content - page().free());
  const settledFree = () => Math.max(0, page().viewport() - (content - page().free()));
  const release = () => {
    setFloor(0);
    holding = false;
    nextLayout(() => {
      const { dock, dockingAfter, free } = page();
      dock(dockingAfter(free()));
    });
  };
  const slideTo = (target: number) => {
    if (target >= floor - SETTLED || reduceMotion() === true) return release();
    const step = run;
    floor = target;
    Animated.timing(minHeight, { toValue: target, duration: SIDEBAR_MOTION.listSlide, easing: curve.cssEase, useNativeDriver: false }).start(({ finished }) => {
      if (finished && step === run) release();
    });
  };
  const undockFirst = () => {
    const { undockRoom, free, viewport } = page();
    const room = undockRoom();
    const raised = content + room;
    const freeBefore = free();
    const viewportBefore = viewport();
    undocked = true;
    setFloor(raised);
    after(
      () => content >= raised - SETTLED && page().free() >= freeBefore + room - SETTLED,
      () => {
        const { docked, dockingAfter, dock } = page();
        if (!docked() || dockingAfter(settledFree())) return settle();
        dock(false);
        after(() => page().viewport() >= viewportBefore + room - SETTLED, settle);
      },
    );
  };
  const settle = () => {
    const { docked, dockingAfter } = page();
    if (!undocked && docked() && !dockingAfter(settledFree())) return undockFirst();
    slideTo(settledLength());
  };

  return {
    minHeight,
    holding: () => holding,
    enter() {
      if (!page().active) return;
      stop();
      setFloor(content);
      pointerIn = true;
      holding = true;
      counted = false;
      consent = consentToken();
      seen = sidebarNow();
    },
    leave() {
      pointerIn = false;
      if (!holding) return;
      stop();
      undocked = false;
      if (closePending()) nextLayout(settle);
      else settle();
    },
    reset() {
      pointerIn = false;
      holding = false;
      stop();
      setFloor(0);
    },
    measured(height) {
      content = height;
      if (pointerIn && height > floor) setFloor(height);
      wake();
    },
    laidOut() {
      const free = page().free();
      const grew = free > lastFree + SETTLED;
      lastFree = free;
      if (pointerIn && seen && !counted && grew && sidebarTabClosedSince(seen, page().windowId, page().profileId)) {
        counted = true;
        noteSidebarListHeld(consent);
      }
      laid = seen = sidebarNow();
      layouts++;
      wake();
    },
    resized: wake,
  };
}

export function useListHold(page: HoldPage): ListHold {
  const latest = useRef(page);
  latest.current = page;
  const [hold] = useState(() => createListHold(() => latest.current));
  useEffect(() => {
    if (!page.active) hold.reset();
  }, [page.active]);
  useEffect(() => hold.reset, []);
  return hold;
}
