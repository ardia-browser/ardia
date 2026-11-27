import { useEffect, useState } from "react";
import { Animated } from "react-native";
import { space } from "../ui/tokens";

export const ROW_HEIGHT = 40;
export const SEEK_ROW = 18;
export const CONTROLS_ROW = 32;
export const EXPANDED_BOTTOM = space.xs;
export const EXPANDED_HEIGHT = ROW_HEIGHT + SEEK_ROW + CONTROLS_ROW + EXPANDED_BOTTOM;
export const GROWTH = EXPANDED_HEIGHT - ROW_HEIGHT;

export type PlayerSlot = "row" | "expanded";
export type Expansion = { expanded: boolean; slot: PlayerSlot };

const AT_REST: Expansion = { expanded: false, slot: "row" };

export type ExpansionState = {
  get: () => Expansion;
  set: (patch: Partial<Expansion>) => void;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
};

export type PlayerMotion = {
  progress: Animated.Value;
  overhang: Animated.Value;
  listClip: Animated.AnimatedMultiplication<number>;
  listUnclip: Animated.AnimatedMultiplication<number>;
  expandedSlot: { current: boolean };
  target: { current: number | null };
  cards: { current: number };
  state: ExpansionState;
  shared: boolean;
};

function expansionState(): ExpansionState {
  let current = AT_REST;
  const listeners = new Set<() => void>();
  const publish = (next: Expansion) => {
    if (next.expanded === current.expanded && next.slot === current.slot) return;
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => current,
    set: (patch) => publish({ ...current, ...patch }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    reset: () => publish(AT_REST),
  };
}

export function makePlayerMotion(shared = false): PlayerMotion {
  const progress = new Animated.Value(0);
  const overhang = new Animated.Value(1);
  const listClip = Animated.multiply(progress.interpolate({ inputRange: [0, 1], outputRange: [0, -GROWTH] }), overhang);
  return { progress, overhang, listClip, listUnclip: Animated.multiply(listClip, -1), expandedSlot: { current: false }, target: { current: null }, cards: { current: 0 }, state: expansionState(), shared };
}

export function settlePlayerMotion(motion: PlayerMotion) {
  motion.progress.setValue(0);
  motion.overhang.setValue(1);
  motion.expandedSlot.current = false;
  motion.target.current = null;
  motion.state.reset();
}

export function holdPlayerCard(motion: PlayerMotion): () => void {
  motion.cards.current++;
  return () => {
    motion.cards.current--;
    if (motion.cards.current === 0) settlePlayerMotion(motion);
  };
}

const windowMotions = new Map<string, { motion: PlayerMotion; users: number }>();

export function windowPlayerMotion(windowId: string): PlayerMotion {
  let entry = windowMotions.get(windowId);
  if (!entry) windowMotions.set(windowId, (entry = { motion: makePlayerMotion(true), users: 0 }));
  return entry.motion;
}

function holdWindowPlayerMotion(windowId: string): () => void {
  windowPlayerMotion(windowId);
  const entry = windowMotions.get(windowId)!;
  entry.users++;
  return () => {
    entry.users--;
    if (entry.users > 0 || windowMotions.get(windowId) !== entry) return;
    windowMotions.delete(windowId);
    settlePlayerMotion(entry.motion);
  };
}

export function usePlayerMotion(sharedBy: string | null): PlayerMotion {
  const [own] = useState(() => makePlayerMotion());
  useEffect(() => (sharedBy ? holdWindowPlayerMotion(sharedBy) : undefined), [sharedBy]);
  return sharedBy ? windowPlayerMotion(sharedBy) : own;
}

export const visibleCardHeight = (slot: PlayerSlot, progress: number): number => (slot === "expanded" ? EXPANDED_HEIGHT : ROW_HEIGHT + GROWTH * progress);

export function revealOf(progress: Animated.Value, pin: Animated.Value, { titleDrop, controlsLift }: { titleDrop: number; controlsLift: number }) {
  return {
    pin,
    unpinned: pin.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    trailing: Animated.add(progress.interpolate({ inputRange: [0, 0.5], outputRange: [1, 0], extrapolate: "clamp" }), pin).interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: "clamp" }),
    mask: progress.interpolate({ inputRange: [0, 1], outputRange: [GROWTH, 0] }),
    unmask: progress.interpolate({ inputRange: [0, 1], outputRange: [-GROWTH, 0] }),
    titleDrop: progress.interpolate({ inputRange: [0, 1], outputRange: [titleDrop, 0] }),
    artist: progress.interpolate({ inputRange: [0.3, 1], outputRange: [0, 1], extrapolate: "clamp" }),
    seek: progress.interpolate({ inputRange: [0.7, 1], outputRange: [0, 1], extrapolate: "clamp" }),
    controls: progress.interpolate({ inputRange: [0.45, 1], outputRange: [0, 1], extrapolate: "clamp" }),
    controlsLift: progress.interpolate({ inputRange: [0, 1], outputRange: [-GROWTH + controlsLift, 0] }),
    closing: progress.interpolate({ inputRange: [0.5, 1], outputRange: [0, 1], extrapolate: "clamp" }),
  };
}
