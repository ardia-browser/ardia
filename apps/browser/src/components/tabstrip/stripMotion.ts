import { createContext, useContext, useLayoutEffect, useMemo, useReducer, useRef, useState, type Ref } from "react";
import type { View } from "react-native";
import { workspaceSnapshot } from "../../state/browser/current";
import type { StripEntry } from "../../state/tabs/topStrip";
import { reduceMotion } from "../ui/reduceMotion";
import { ackStripPress, matchStripPress } from "../../state/tabs/stripPress";
import { useAnimatedStyle } from "../sidebar/EntryMotion";
import type { Dock } from "./model";
import type { DragGeometry } from "./stripGroups";
import { band, createMotion, plan, shoot, type Plan, type Shot, type StripMotion } from "./stripSlides";

export { NEW_TAB_SLOT, type StripGhost, type StripMotion, type StripSlide } from "./stripSlides";

export const StripMotionContext = createContext<StripMotion | null>(null);

export type StripMotionInput = { entries: StripEntry[]; top: DragGeometry; dock: Dock | null; flare: number; end: number | null; viewport: number; offset: () => number; windowId: string; enabled: boolean };

export function useStripMotion({ entries, top, dock, flare, end, viewport, offset, windowId, enabled }: StripMotionInput): StripMotion {
  const [own] = useState(createMotion);
  const last = useRef<Shot | null>(null);
  const inputs = useRef<unknown[]>([]);
  const shot = useRef<Shot | null>(null);
  const queued = useRef<Plan | null>(null);
  const start = flare + (dock ? -dock.left : 0);
  const given = [entries, top, start, end];
  if (!shot.current || given.some((v, i) => v !== inputs.current[i])) {
    inputs.current = given;
    shot.current = shoot(entries, top, start, end === null ? null : start + end, workspaceSnapshot());
  }
  const now = shot.current;
  const before = last.current;
  const changed = enabled && !!before && before !== now && before.state.tabs !== now.state.tabs;
  queued.current = changed ? plan(before, now, own.slides, band(offset(), viewport), Date.now(), reduceMotion() === true, (closed, opened) => matchStripPress(windowId, closed, opened)) : null;
  useLayoutEffect(() => {
    last.current = now;
    const p = queued.current;
    queued.current = null;
    if (p?.stepped) own.motion.land();
    if (p) ackStripPress(windowId, p.pressed);
    if (p) own.apply(p);
  });
  return own.motion;
}

export function useStripSlide(key: string | null): [Record<string, unknown>, Ref<View>] {
  const motion = useContext(StripMotionContext);
  const [, changed] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => (motion && key ? motion.subscribe(key, changed) : undefined), [motion, key]);
  const slide = motion && key ? motion.slide(key) : null;
  const style = useMemo(() => (slide ? (slide.opacity ? { transform: [{ translateX: slide.value }], opacity: slide.opacity } : { transform: [{ translateX: slide.value }] }) : null), [slide]);
  const [props, ref] = useAnimatedStyle(style);
  useLayoutEffect(() => (motion && slide ? motion.mount(slide) : undefined), [motion, slide]);
  return [props, ref];
}
