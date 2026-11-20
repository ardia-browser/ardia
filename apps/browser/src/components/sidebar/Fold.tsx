import { createContext, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Animated, View, type LayoutChangeEvent } from "react-native";
import { curve } from "../ui/motion";
import { layout } from "../ui/theme";
import { noteSidebarMotion } from "../../state/telemetry/usage";
import { FoldedAway } from "./hoverController";
import { devScale } from "./ListMotion";
import { SIDEBAR_MOTION } from "./tokens";
import { FoldEntryContext, useCollapsingSlot } from "./DragProvider";

const FOLD_MS = SIDEBAR_MOTION.fold;
const FOLD_EASING = curve.enter;
const FREE = { position: "absolute", left: 0, right: 0, top: 0 } as const;
const NONE: string[] = [];
const FoldResized = createContext<(() => void) | null>(null);

type FoldState = { open: Animated.Value; moving: boolean };

export function useFold(collapsed: boolean): FoldState {
  const open = useRef(new Animated.Value(collapsed ? 0 : 1)).current;
  const [settled, setSettled] = useState(collapsed);
  const [running, setRunning] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setRunning(true);
    const animation = Animated.timing(open, { toValue: collapsed ? 0 : 1, duration: FOLD_MS * devScale(), easing: FOLD_EASING, useNativeDriver: false });
    animation.start(({ finished }) => {
      if (!finished) return;
      setSettled(collapsed);
      setRunning(false);
    });
    return () => animation.stop();
  }, [collapsed]);
  return { open, moving: running || settled !== collapsed };
}

export type FoldEntry = { key: string; node: ReactNode; ghost?: boolean };

type Turn = { value: Animated.Value; size: Animated.Value; height: number; shown: boolean; style: object; ghost?: ReactNode };
type Shown = { keys: string[]; order: string[]; turns: Map<string, Turn> };
type Step = { keys: string[]; settled: boolean; collapsed: boolean; turn: (key: string, shown: boolean) => Turn; reach: (key: string) => number; farewell?: (key: string) => ReactNode };

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((key, i) => key === b[i]);

const turnTo = (value: Animated.Value, toValue: number) =>
  Animated.timing(value, { toValue, duration: SIDEBAR_MOTION.listSlide * devScale(), easing: curve.cssEase, useNativeDriver: false });

function turnFrom(shown: boolean, height: number, gap: number): Turn {
  const value = new Animated.Value(shown ? 0 : 1);
  const size = new Animated.Value(height);
  const style = {
    height: Animated.multiply(value, size),
    marginBottom: value.interpolate({ inputRange: [0, 1], outputRange: [-gap, 0] }),
    opacity: value,
    overflow: "hidden",
  };
  return { value, size, height, shown, style };
}

function withGhosts(order: string[], entries: FoldEntry[], turns: Map<string, Turn>, seen: (key: string) => boolean): FoldEntry[] {
  const present = new Set(entries.map((e) => e.key));
  const before = new Map<string, FoldEntry[]>();
  let waiting: FoldEntry[] = [];
  for (const key of order) {
    const ghost = present.has(key) ? null : turns.get(key)?.ghost;
    if (ghost) waiting.push({ key, node: ghost });
    else if (present.has(key) && seen(key) && waiting.length) {
      before.set(key, waiting);
      waiting = [];
    }
  }
  if (!before.size && !waiting.length) return entries;
  return [...entries.flatMap((e) => [...(before.get(e.key) ?? []), e]), ...waiting];
}

function advance(was: Shown, entries: FoldEntry[], { keys, settled, collapsed, turn, reach, farewell }: Step): Shown {
  const resync = !sameKeys(was.keys, keys);
  if (!resync && !was.turns.size) return was;
  const turns = new Map(was.turns);
  if (resync && settled) {
    for (const key of keys) if (!was.keys.includes(key) && !turns.has(key)) turns.set(key, turn(key, true));
    for (const key of was.keys) if (!keys.includes(key) && !turns.has(key)) turns.set(key, turn(key, false));
  }
  const live = new Set(entries.flatMap((e) => (e.ghost ? [] : [e.key])));
  const showing = new Set(keys);
  const seen = (key: string) => !collapsed || showing.has(key) || turns.has(key);
  let changed = resync;
  for (const [key, t] of turns) {
    const alive = live.has(key);
    const shown = alive && (showing.has(key) || !collapsed);
    const height = shown ? reach(key) : t.height;
    if (alive ? t.shown === shown && t.height === height && !t.ghost : t.ghost) continue;
    changed = true;
    const ghost = alive || !collapsed ? undefined : farewell?.(key);
    if (alive || ghost) turns.set(key, { ...t, shown, height, ghost });
    else turns.delete(key);
  }
  return changed ? { keys, order: withGhosts(was.order, entries, turns, seen).map((e) => e.key), turns } : was;
}

function useEased(target: number, animate: boolean) {
  const [value] = useState(() => new Animated.Value(target));
  useLayoutEffect(() => {
    if (!animate) return void value.setValue(target);
    const run = turnTo(value, target);
    run.start();
    return () => run.stop();
  }, [target]);
  return value;
}

export function Fold({
  fold,
  collapsed,
  entries,
  keep,
  rowHeight,
  estimate,
  padTop = 0,
  padBottom = 0,
  indent = 0,
  indentEnd = 0,
  mountClosed = false,
  footer,
  farewell,
}: {
  fold: FoldState;
  collapsed: boolean;
  entries: FoldEntry[];
  keep?: string | string[] | null;
  rowHeight?: number | ((key: string) => number);
  estimate?: (key: string) => number;
  padTop?: number;
  padBottom?: number;
  indent?: number;
  indentEnd?: number;
  mountClosed?: boolean;
  footer?: ReactNode;
  farewell?: (key: string) => ReactNode;
}) {
  const { open, moving } = fold;
  const gap = layout.rowGap;
  const parentAway = useContext(FoldedAway);
  const measuring = rowHeight === undefined;
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const styles = useRef(new Map<number, object>()).current;
  const rested = useRef(new Map<string, number>()).current;
  const runs = useRef(new Map<Turn, Animated.CompositeAnimation>()).current;
  const resized = useContext(FoldResized);
  const enclosing = useRef(resized);
  enclosing.current = resized;
  const [, refit] = useReducer((n: number) => n + 1, 0);
  const [onResized] = useState(() => () => {
    if (runs.size) refit();
    enclosing.current?.();
  });
  const kept = new Set([keep ?? []].flat().filter((key) => entries.some((e) => e.key === key)));
  const settled = collapsed && !moving;
  const record = (key: string, height: number) => setMeasured((all) => (all[key] === height ? all : { ...all, [key]: height }));
  const heightOf = (key: string) => (typeof rowHeight === "function" ? rowHeight(key) : (rowHeight ?? measured[key] ?? estimate?.(key) ?? 0));
  const keys = collapsed ? entries.flatMap((e) => (kept.has(e.key) && !e.ghost ? [e.key] : [])) : NONE;
  const [shown, setShown] = useState<Shown>(() => ({ keys, order: entries.map((e) => e.key), turns: new Map() }));
  const ready = !settled || !measuring || !!estimate || keys.every((key) => measured[key] !== undefined);
  if (ready && (collapsed || shown.turns.size)) {
    const reach = (key: string) => estimate?.(key) ?? heightOf(key);
    const turn = (key: string, show: boolean) => turnFrom(show, show ? reach(key) : (rested.get(key) ?? heightOf(key)), gap);
    const next = advance(shown, entries, { keys, settled, collapsed, turn, reach, farewell });
    if (next !== shown) setShown(next);
  }
  useLayoutEffect(() => {
    const current = new Set(shown.turns.values());
    const carried = new Map<Animated.Value, boolean>();
    for (const [turn, run] of runs) {
      if (current.has(turn)) continue;
      run.stop();
      runs.delete(turn);
      carried.set(turn.value, turn.shown);
    }
    let started = false;
    for (const [key, turn] of shown.turns) {
      if (runs.has(turn)) continue;
      started = true;
      if (carried.get(turn.value) !== turn.shown) noteSidebarMotion("keptRowFold");
      const unfold = turnTo(turn.value, turn.shown ? 1 : 0);
      const run = carried.has(turn.value) ? Animated.parallel([unfold, turnTo(turn.size, turn.height)]) : unfold;
      runs.set(turn, run);
      run.start(({ finished }) => {
        if (!finished) return;
        if (!turn.shown) rested.delete(key);
        setShown((s) => (s.turns.get(key) === turn ? { ...s, turns: new Map([...s.turns].filter(([other]) => other !== key)) } : s));
      });
    }
    if (started) resized?.();
  }, [shown.turns]);
  useLayoutEffect(() => void resized?.(), [collapsed]);
  useLayoutEffect(() => () => runs.forEach((run) => run.stop()), []);
  const showing = settled ? new Set(shown.keys) : kept;
  const folding = (kept.size > 0 || shown.turns.size > 0) && (collapsed || moving);
  const animate = settled && shown.turns.size > 0;
  const paddingTop = useEased(settled && !shown.keys.length ? 0 : padTop, animate);
  const paddingBottom = useEased(settled && !shown.keys.length ? 0 : padBottom, animate);
  const rows = entries.filter((e) => !e.ghost);
  const total = rows.reduce((sum, e) => sum + heightOf(e.key), 0) + gap * Math.max(0, rows.length - 1) + padTop + padBottom;
  const foldingStyle = (height: number) => {
    let style = styles.get(height);
    if (!style) {
      style = {
        height: open.interpolate({ inputRange: [0, 1], outputRange: [0, height] }),
        marginBottom: open.interpolate({ inputRange: [0, 1], outputRange: [-gap, 0] }),
        opacity: open,
        overflow: "hidden",
      };
      styles.set(height, style);
    }
    return style;
  };
  const closed = { height: 0, marginBottom: -gap, opacity: 0, overflow: "hidden" as const };
  const outer = folding
    ? null
    : moving
      ? { height: open.interpolate({ inputRange: [0, 1], outputRange: [0, total] }), opacity: open, overflow: "hidden" as const }
      : collapsed
        ? { height: 0, opacity: 0, overflow: "hidden" as const }
        : null;
  const mountAll = !collapsed || moving || mountClosed || (measuring && !estimate);

  return (
    <Animated.View style={outer} pointerEvents={collapsed ? "box-none" : "auto"}>
      <Animated.View removeClippedSubviews style={[{ gap, paddingTop, paddingBottom, paddingLeft: indent, paddingRight: indentEnd }, measuring && outer && !moving ? FREE : null]}>
        <FoldResized.Provider value={onResized}>
          {(shown.turns.size ? withGhosts(shown.order, entries, shown.turns, (key) => !collapsed || showing.has(key) || shown.turns.has(key)) : entries).map(({ key, node }) => {
            const stays = showing.has(key);
            const turn = shown.turns.get(key);
            if (!stays && !kept.has(key) && !mountAll && !turn) return null;
            const hidden = folding && !stays;
            return (
              <FoldedAway.Provider key={key} value={parentAway || ((collapsed || moving) && !stays)}>
                <FoldSlot
                  entryKey={key}
                  gap={gap}
                  style={turn?.style ?? (hidden ? (moving ? foldingStyle(heightOf(key)) : closed) : null)}
                  pointerEvents={collapsed && !stays ? "none" : "auto"}
                  onLayout={kept.has(key) ? (e) => void rested.set(key, e.nativeEvent.layout.height) : undefined}
                >
                  {measuring ? (
                    <View style={turn || hidden ? FREE : undefined} onLayout={(e) => record(key, e.nativeEvent.layout.height)}>
                      {node}
                    </View>
                  ) : (
                    node
                  )}
                </FoldSlot>
              </FoldedAway.Provider>
            );
          })}
          {footer}
        </FoldResized.Provider>
      </Animated.View>
    </Animated.View>
  );
}

function FoldSlot({ entryKey, gap, style, pointerEvents, onLayout, children }: { entryKey: string; gap: number; style: object | null; pointerEvents: "none" | "auto"; onLayout?: (e: LayoutChangeEvent) => void; children: ReactNode }) {
  const collapsing = useCollapsingSlot(entryKey, gap);
  return (
    <Animated.View style={collapsing ? [style, collapsing] : style} pointerEvents={pointerEvents} onLayout={onLayout}>
      <FoldEntryContext.Provider value>{children}</FoldEntryContext.Provider>
    </Animated.View>
  );
}
