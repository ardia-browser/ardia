import { Animated } from "react-native";
import type { BrowserState } from "../../state/browser/store";
import { tabTitle } from "../../state/browser/model";
import type { StripEntry } from "../../state/tabs/topStrip";
import { consentToken, type ConsentToken } from "../../state/telemetry/client";
import { noteTabMotion } from "../../state/telemetry/tabMotionCounts";
import { tabsOf, type DragGeometry } from "./stripGroups";
import { STRIP_MOTION } from "./tokens";

export const NEW_TAB_SLOT = "~new";
const FRAME_SLACK_MS = 50;
const BAND_MARGIN = 48;

type Run = Animated.CompositeAnimation;
type StripSlide = { key: string; value: Animated.Value; opacity: Animated.Value | null; from: number; at: number; until: number; moving: number; fading: boolean; appearAt: number | null; pending: boolean; mounted: boolean; consent: ConsentToken | null };
type GhostTab = { title: string; url: string; favicon?: string | null; icon?: string | null; profileId: string };
export type StripGhost = { key: string; x: number; width: number; tab: GhostTab; opacity: Animated.Value; until: number; started: boolean };
export type Shot = { keys: string[]; x: Map<string, number>; width: Map<string, number>; tabs: Map<string, string[]>; shown: Map<string, string[]>; groups: Set<string>; end: number | null; state: BrowserState };
type Move = { key: string; from: number };
export type Plan = { moves: Move[]; appears: string[]; ghosts: StripGhost[]; at: number; stepped: boolean; pressed: string[] };

export type StripMotion = {
  slide: (key: string) => StripSlide | null;
  subscribe: (key: string, changed: () => void) => () => void;
  mount: (slide: StripSlide) => () => void;
  ghosts: () => StripGhost[];
  watchGhosts: (changed: () => void) => () => void;
  fade: (ghost: StripGhost) => void;
  land: () => void;
};

const slideKey = (e: StripEntry) => (e.kind === "group" ? `group:${e.id}` : e.kind === "dock" ? null : tabsOf(e)[0]!);
const slideEasing = STRIP_MOTION.slideEasing;
let ghostIds = 0;

export function shoot(entries: StripEntry[], top: DragGeometry, start: number, end: number | null, state: BrowserState): Shot {
  const shot: Shot = { keys: [], x: new Map(), width: new Map(), tabs: new Map(), shown: new Map(), groups: new Set(), end, state };
  let i = 0;
  for (const e of entries) {
    const key = slideKey(e);
    if (key === null) continue;
    const slot = top.slots[i];
    const left = top.lefts[i++];
    if (!slot || left === undefined) break;
    shot.keys.push(key);
    shot.x.set(key, start + left);
    shot.width.set(key, slot.width);
    shot.tabs.set(key, slot.tabIds);
    shot.shown.set(key, e.kind !== "group" ? slot.tabIds : e.collapsed ? [] : e.members.flatMap(tabsOf));
    if (e.kind === "group") shot.groups.add(key);
  }
  return shot;
}

function shownAt(slide: StripSlide | undefined, now: number): number {
  if (!slide?.opacity) return 1;
  if (slide.appearAt === null) return 0;
  return slide.fading ? STRIP_MOTION.appearEasing(Math.min(1, Math.max(0, (now - slide.appearAt) / STRIP_MOTION.appear))) : 1;
}

export function offsetAt(slide: StripSlide | undefined, now: number): number {
  if (!slide || (!slide.moving && !slide.pending)) return 0;
  const p = Math.min(1, Math.max(0, (now - slide.at) / STRIP_MOTION.slide));
  return slide.from * (1 - slideEasing(p));
}

function ghostTab(s: BrowserState, tabId: string): GhostTab | null {
  const tab = s.tabs[tabId];
  return tab ? { title: tabTitle(tab), url: tab.url, favicon: tab.favicon, icon: tab.customIcon, profileId: tab.profileId } : null;
}

function memberChanges(before: Shot, after: Shot, had: Set<string>) {
  const closed: string[] = [];
  const opened: string[] = [];
  for (const key of after.keys) {
    if (!had.has(key)) continue;
    const was = before.shown.get(key)!;
    const is = after.shown.get(key)!;
    for (const id of was) if (!is.includes(id) && !after.state.tabs[id]) closed.push(id);
    for (const id of is) if (!was.includes(id) && !before.state.tabs[id]) opened.push(id);
  }
  return { closed, opened };
}

export function plan(before: Shot, after: Shot, slides: Map<string, StripSlide>, band: [number, number], now: number, still: boolean, matchPress: (closed: string[], opened: string[]) => string[] = () => []): Plan | null {
  const had = new Set(before.keys);
  const has = new Set(after.keys);
  const removed = before.keys.filter((k) => !has.has(k));
  const added = after.keys.filter((k) => !had.has(k));
  const members = memberChanges(before, after, had);
  const memberChanged = members.closed.length > 0 || members.opened.length > 0;
  const closed = removed.filter((k) => before.tabs.get(k)!.every((id) => !after.state.tabs[id]));
  const opened = added.filter((k) => after.tabs.get(k)!.every((id) => !before.state.tabs[id]));
  if (!closed.length && !opened.length && !memberChanged) return null;
  const pressed = matchPress([...closed.flatMap((k) => before.tabs.get(k)!), ...members.closed], [...opened.flatMap((k) => after.tabs.get(k)!), ...members.opened]);
  if (!removed.length && !added.length) return { moves: [], appears: [], ghosts: [], at: now, stepped: true, pressed };
  const stepped = pressed.length > 0 || memberChanged;
  const seen = (x: number, width: number) => x + width > band[0] && x < band[1];
  const moves: Move[] = [];
  const blocked = still || stepped;
  for (const key of after.keys) {
    if (!had.has(key)) continue;
    const delta = before.x.get(key)! - after.x.get(key)!;
    if (Math.abs(delta) < 0.5) continue;
    const live = slides.get(key);
    const from = offsetAt(live, now) + delta;
    if (Math.abs(from) < 0.5) {
      if (live?.moving || live?.pending) moves.push({ key, from: 0 });
      continue;
    }
    if (blocked || after.groups.has(key)) continue;
    const width = after.width.get(key)!;
    if (live?.moving || seen(after.x.get(key)!, width) || seen(before.x.get(key)!, width)) moves.push({ key, from });
  }
  if (!blocked && before.end !== null && after.end !== null && Math.abs(before.end - after.end) >= 0.5) {
    const live = slides.get(NEW_TAB_SLOT);
    const from = offsetAt(live, now) + before.end - after.end;
    if (Math.abs(from) >= 0.5) moves.push({ key: NEW_TAB_SLOT, from });
    else if (live?.moving || live?.pending) moves.push({ key: NEW_TAB_SLOT, from: 0 });
  }
  const appears = opened.filter((k) => !after.groups.has(k) && seen(after.x.get(k)!, after.width.get(k)!));
  const ghosts = closed.flatMap((k): StripGhost[] => {
    const ids = before.tabs.get(k)!;
    const x = before.x.get(k)! + offsetAt(slides.get(k), now);
    const width = before.width.get(k)!;
    const tab = ids.length === 1 && !before.groups.has(k) ? ghostTab(before.state, ids[0]!) : null;
    return tab && seen(x, width) ? [{ key: `ghost:${++ghostIds}`, x, width, tab, opacity: new Animated.Value(shownAt(slides.get(k), now)), until: 0, started: false }] : [];
  });
  if (!moves.length && !appears.length && !ghosts.length && !stepped) return null;
  return { moves, appears, ghosts, at: now, stepped, pressed };
}

export function createMotion() {
  const slides = new Map<string, StripSlide>();
  const watchers = new Map<string, Set<() => void>>();
  const ghostWatchers = new Set<() => void>();
  let ghosts: StripGhost[] = [];
  const notify = (key: string) => {
    for (const changed of watchers.get(key) ?? []) changed();
  };
  const notifyGhosts = () => {
    for (const changed of ghostWatchers) changed();
  };
  const settle = (slide: StripSlide) => {
    if (slide.moving || slide.fading || slide.pending || slides.get(slide.key) !== slide) return;
    slides.delete(slide.key);
    notify(slide.key);
  };
  let runs = 0;
  const move = (slide: StripSlide) => {
    const run: Run = Animated.timing(slide.value, { toValue: 0, duration: STRIP_MOTION.slide, easing: slideEasing, useNativeDriver: true });
    const id = (slide.moving = ++runs);
    run.start(() => {
      if (slide.moving !== id) return;
      slide.moving = 0;
      settle(slide);
    });
  };
  const fadeIn = (slide: StripSlide, opacity: Animated.Value) => {
    slide.fading = true;
    slide.appearAt = Date.now();
    Animated.timing(opacity, { toValue: 1, duration: STRIP_MOTION.appear, easing: STRIP_MOTION.appearEasing, useNativeDriver: true }).start(() => {
      slide.fading = false;
      settle(slide);
    });
  };
  const start = (slide: StripSlide) => {
    if (!slide.pending) return;
    slide.pending = false;
    slide.consent = consentToken();
    slide.until = slide.at + STRIP_MOTION.slide + FRAME_SLACK_MS;
    if (slide.from) move(slide);
    if (slide.opacity && slide.appearAt === null) fadeIn(slide, slide.opacity);
    settle(slide);
  };
  const prune = (now: number) => {
    for (const slide of slides.values()) {
      const fadeOver = slide.fading && slide.appearAt !== null && now > slide.appearAt + STRIP_MOTION.appear + FRAME_SLACK_MS;
      if (fadeOver) slide.opacity?.stopAnimation();
      if (!slide.until || now < slide.until) continue;
      if (slide.moving || fadeOver) noteTabMotion(slide.consent, "strip", "overrun");
      slide.moving = 0;
      slide.value.stopAnimation();
      slide.pending = false;
      settle(slide);
    }
    for (const slide of slides.values()) if (slide.pending && !slide.mounted && now - slide.at > STRIP_MOTION.slide) settle(Object.assign(slide, { pending: false }));
    const left = ghosts.filter((g) => !g.until || now < g.until + FRAME_SLACK_MS);
    if (left.length !== ghosts.length) {
      ghosts = left;
      notifyGhosts();
    }
  };
  const apply = (p: Plan) => {
    prune(p.at);
    const consent = consentToken();
    if ([...slides.values()].some((s) => s.moving)) noteTabMotion(consent, "strip", "interrupt");
    const fresh: string[] = [];
    const restart: StripSlide[] = [];
    for (const m of p.moves) {
      const live = slides.get(m.key);
      if (live) {
        live.pending = true;
        live.value.stopAnimation();
        live.value.setValue(m.from);
        Object.assign(live, { from: m.from, at: p.at });
        if (live.mounted) restart.push(live);
        continue;
      }
      slides.set(m.key, { key: m.key, value: new Animated.Value(m.from), opacity: null, from: m.from, at: p.at, until: 0, moving: 0, fading: false, appearAt: null, pending: true, mounted: false, consent: null });
      fresh.push(m.key);
    }
    for (const key of p.appears) {
      slides.set(key, { key, value: new Animated.Value(0), opacity: new Animated.Value(0), from: 0, at: p.at, until: 0, moving: 0, fading: false, appearAt: null, pending: true, mounted: false, consent: null });
      fresh.push(key);
    }
    if (p.ghosts.length) {
      ghosts = [...ghosts, ...p.ghosts];
      notifyGhosts();
    }
    for (const slide of restart) start(slide);
    for (const key of fresh) notify(key);
    if (p.appears.length) noteTabMotion(consent, "strip", "open", p.appears.length);
    if (p.ghosts.length) noteTabMotion(consent, "strip", "close", p.ghosts.length);
  };
  const land = () => {
    for (const slide of [...slides.values()]) {
      slide.moving = 0;
      slide.from = 0;
      slide.value.stopAnimation();
      slide.value.setValue(0);
      if (!slide.opacity || slide.appearAt !== null) slide.pending = false;
      settle(slide);
    }
  };
  const motion: StripMotion = {
    land,
    slide: (key) => slides.get(key) ?? null,
    subscribe: (key, changed) => {
      let set = watchers.get(key);
      if (!set) watchers.set(key, (set = new Set()));
      set.add(changed);
      return () => {
        set.delete(changed);
        if (!set.size) watchers.delete(key);
      };
    },
    mount: (slide) => {
      slide.mounted = true;
      start(slide);
      return () => void (slide.mounted = false);
    },
    ghosts: () => ghosts,
    watchGhosts: (changed) => {
      ghostWatchers.add(changed);
      return () => void ghostWatchers.delete(changed);
    },
    fade: (ghost) => {
      if (ghost.started) return;
      ghost.started = true;
      ghost.until = Date.now() + STRIP_MOTION.fade;
      Animated.timing(ghost.opacity, { toValue: 0, duration: STRIP_MOTION.fade, easing: STRIP_MOTION.fadeEasing, useNativeDriver: true }).start(({ finished }) => {
        if (!finished || !ghosts.includes(ghost)) return;
        ghosts = ghosts.filter((g) => g !== ghost);
        notifyGhosts();
      });
    },
  };
  return { motion, apply, slides };
}

export const band = (scrolled: number, viewport: number): [number, number] => [scrolled - BAND_MARGIN, scrolled + viewport + BAND_MARGIN];
