import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, View } from "react-native";
import { curve } from "../ui/motion";
import { animateNextLayout, layoutOnCompositor } from "../ui/layoutMotion";
import { layout } from "../ui/theme";
import { useWindowId } from "../../state/browser/hooks";
import { windowRootHeightNow } from "../../state/windows/rootSize";
import { FoldedAway, type AwaySource } from "./hoverController";
import { SIDEBAR_MOTION } from "./tokens";
import { FoldEntryContext, useCollapsingSlot } from "./DragProvider";
import { foldReach, foldRows, nextFoldMount, rowsWithin, type FoldMount } from "./foldRows";
import { fillingFold } from "./foldFlush";
import { noteFoldMotion } from "../../state/telemetry/foldMotion";

const FOLD_MS = SIDEBAR_MOTION.fold;
const FOLD_EASING = curve.enter;
const HIDDEN = { display: "none" } as const;
const GLIDE_SHUT = 0.5;
const FOLD_CURVE_POINTS = [0.33, 1, 0.68, 1] as const;
const UNMEASURED_WINDOW_HEIGHT = 1200;
const FIRST_REVEAL = 0.3;
const REVEAL_AHEAD = 0.25;

type FoldState = { open: Animated.Value; moving: boolean; finish: () => void };

export const FoldSettling = createContext(false);

type FoldStep = "rest" | "snap" | "move";
type FoldMotion = { collapsed: boolean; step: FoldStep };

export function useFold(collapsed: boolean): FoldState {
  const open = useRef(new Animated.Value(collapsed ? 0 : 1)).current;
  const [settled, setSettled] = useState(collapsed);
  const [running, setRunning] = useState(false);
  const mounted = useRef(false);
  const animating = useRef<Animated.CompositeAnimation | null>(null);
  const [finish] = useState(() => () => animating.current?.stop());
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setRunning(true);
    const timing = noteFoldMotion(FOLD_MS);
    const animation = Animated.timing(open, { toValue: collapsed ? 0 : 1, duration: FOLD_MS, easing: FOLD_EASING, useNativeDriver: layoutOnCompositor });
    animating.current = animation;
    let cancelled = false;
    animation.start(({ finished }) => {
      timing.end(finished);
      if (animating.current === animation) animating.current = null;
      if (cancelled) return;
      if (!finished) open.setValue(collapsed ? 0 : 1);
      setSettled(collapsed);
      setRunning(false);
    });
    return () => {
      cancelled = true;
      animation.stop();
    };
  }, [collapsed]);
  return { open, moving: running || settled !== collapsed, finish };
}

export type FoldEntry = { key: string; node: ReactNode; ghost?: boolean };

type AwaySources = { of: (key: string) => AwaySource; changed: () => void };

function useAwaySources(parent: AwaySource, hidden: (key: string) => boolean, keys: string[]): AwaySources {
  const latest = useRef({ parent, hidden });
  latest.current = { parent, hidden };
  const [own] = useState(() => {
    const listeners = new Set<() => void>();
    const sources = new Map<string, AwaySource>();
    const subscribe = (changed: () => void) => {
      listeners.add(changed);
      return () => void listeners.delete(changed);
    };
    return {
      sources,
      of: (key: string) => {
        let source = sources.get(key);
        if (!source) {
          source = { away: () => latest.current.parent.away() || latest.current.hidden(key), subscribe };
          sources.set(key, source);
        }
        return source;
      },
      changed: () => {
        for (const listener of [...listeners]) listener();
      },
    };
  });
  useEffect(() => parent.subscribe(own.changed), [parent, own]);
  if (own.sources.size > keys.length * 2) {
    const live = new Set(keys);
    for (const key of own.sources.keys()) if (!live.has(key)) own.sources.delete(key);
  }
  return own;
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
}) {
  const { open, moving } = fold;
  const gap = layout.rowGap;
  const parentAway = useContext(FoldedAway);
  const ancestorSettling = useContext(FoldSettling);
  const windowId = useWindowId();
  const measuring = rowHeight === undefined;
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const styles = useRef(new Map<number, object>()).current;
  const kept = new Set([keep ?? []].flat().filter((key) => entries.some((e) => e.key === key)));
  const folding = kept.size > 0 && (collapsed || moving);
  const state = useRef({ moving, folding, kept });
  state.current = { moving, folding, kept };
  const heightOf = (key: string) => (typeof rowHeight === "function" ? rowHeight(key) : (rowHeight ?? measured[key] ?? estimate?.(key) ?? 0));
  const rows = entries.filter((e) => !e.ghost);
  const total = rows.reduce((sum, e) => sum + heightOf(e.key), 0) + gap * Math.max(0, rows.length - 1) + padTop + padBottom;
  const reach = foldReach(windowRootHeightNow(windowId) ?? UNMEASURED_WINDOW_HEIGHT, padTop);
  const travel = Math.min(total, reach);
  const partial = !mountClosed && (!measuring || !!estimate);
  const [mount, setMount] = useState<FoldMount>(() => ({ collapsed, shown: collapsed ? 0 : ancestorSettling && partial ? rowsWithin(entries, heightOf, gap, reach) : Infinity }));
  const now = mount.collapsed === collapsed ? mount : nextFoldMount(mount, collapsed, entries, heightOf, gap, folding || layoutOnCompositor ? reach : travel * FIRST_REVEAL);
  if (now !== mount) setMount(now);
  const revealing = !layoutOnCompositor && partial && moving && !collapsed && !folding;
  const reveal = useRef({ entries, heightOf, travel });
  reveal.current = { entries, heightOf, travel };
  useEffect(() => {
    if (!revealing) return;
    const id = open.addListener(({ value }) => {
      const { entries, heightOf, travel } = reveal.current;
      const want = rowsWithin(entries, heightOf, gap, Math.min(travel, (value + REVEAL_AHEAD) * travel));
      setMount((m) => (m.collapsed || m.shown >= want ? m : { collapsed: m.collapsed, shown: want }));
    });
    return () => open.removeListener(id);
  }, [revealing, open, gap]);
  const unfilled = partial && !collapsed && now.shown !== Infinity;
  const growing = unfilled && !moving && !ancestorSettling;
  const pending = unfilled || moving;
  const finishFold = fold.finish;
  useEffect(() => {
    if (!pending) return;
    return fillingFold(windowId, () => {
      finishFold();
      setMount((m) => (m.collapsed ? m : { collapsed: false, shown: Infinity }));
    });
  }, [pending, windowId, finishFold]);
  useEffect(() => {
    if (!growing) return;
    const frame = requestAnimationFrame(() => setMount((m) => (m.collapsed !== collapsed ? m : nextFoldMount(m, collapsed, entries, heightOf, gap, reach, true))));
    return () => cancelAnimationFrame(frame);
  });
  const hiddenKey = (key: string) => (collapsed || moving) && !state.current.kept.has(key);
  const away = useAwaySources(parentAway, hiddenKey, entries.map((e) => e.key));
  const keptKeys = [...kept].join("\n");
  useEffect(() => away.changed(), [collapsed, moving, keptKeys, away]);
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
  const closed = useMemo(() => ({ height: 0, marginBottom: -gap, opacity: 0, overflow: "hidden" as const }), [gap]);
  const fading = useMemo(() => ({ overflow: "hidden" as const, opacity: open }), [open]);
  const fadingShut = useMemo(() => ({ height: GLIDE_SHUT, marginBottom: -gap - GLIDE_SHUT, overflow: "hidden" as const, opacity: open }), [open, gap]);
  const mountAll = !partial && (!collapsed || moving || mountClosed || (measuring && !estimate));
  const shownOpen = !collapsed || moving;
  const plan = foldRows(entries, {
    shown: partial ? now.shown : mountAll ? Infinity : 0,
    kept,
    spacers: partial && shownOpen,
    ghosts: partial ? shownOpen : mountAll,
    heightOf,
    gap,
    reach,
  });
  const [motion, setMotion] = useState<FoldMotion>(() => ({ collapsed, step: "rest" }));
  const outOfReach = folding ? plan.some((slot) => slot.kind === "spacer" || (!slot.inReach && !kept.has(entries[slot.index]!.key))) : total > reach;
  const step: FoldMotion =
    motion.collapsed !== collapsed ? { collapsed, step: collapsed && outOfReach ? "snap" : "move" } : !moving && motion.step !== "rest" ? { collapsed, step: "rest" } : motion;
  if (step !== motion) setMotion(step);
  useLayoutEffect(() => {
    if (!layoutOnCompositor) return;
    if (step.step === "move") return void animateNextLayout(FOLD_MS, FOLD_CURVE_POINTS);
    if (step.step !== "snap") return;
    const frame = requestAnimationFrame(() => setMotion((m) => (m === step ? { collapsed: m.collapsed, step: "move" } : m)));
    return () => cancelAnimationFrame(frame);
  }, [step]);
  const compositor = layoutOnCompositor ? step.step : null;
  const shut = { height: 0, opacity: 0, overflow: "hidden" as const };
  const outer = folding
    ? null
    : compositor !== null
      ? compositor === "rest"
        ? collapsed
          ? shut
          : null
        : { height: collapsed ? (compositor === "snap" ? travel : GLIDE_SHUT) : total > reach ? travel : undefined, opacity: open, overflow: "hidden" as const }
      : moving
        ? { height: open.interpolate({ inputRange: [0, 1], outputRange: [0, travel] }), opacity: open, overflow: "hidden" as const }
        : collapsed
          ? shut
          : null;
  const slotStyle = (key: string, stays: boolean, inReach: boolean) => {
    if (!folding || stays) return null;
    if (!inReach) return collapsed ? HIDDEN : null;
    if (compositor === null) return moving ? foldingStyle(heightOf(key)) : closed;
    if (compositor === "rest") return closed;
    return collapsed && compositor === "move" ? fadingShut : fading;
  };

  return (
    <Animated.View style={outer} pointerEvents={collapsed ? "box-none" : "auto"}>
      <View removeClippedSubviews style={[{ flexShrink: 0, gap, paddingTop: padTop, paddingBottom: padBottom, paddingLeft: indent, paddingRight: indentEnd }, measuring && outer && !moving ? { position: "absolute", left: 0, right: 0, top: 0 } : null, collapsed && !moving && !measuring && !folding ? HIDDEN : null]}>
        <FoldSettling.Provider value={ancestorSettling || moving || unfilled}>
        {plan.map((slot) => {
          if (slot.kind === "spacer") return <Animated.View key={slot.key} style={folding && collapsed ? HIDDEN : { height: slot.height }} />;
          const { key, node } = entries[slot.index]!;
          const stays = kept.has(key);
          const style = slotStyle(key, stays, slot.inReach);
          return (
            <FoldedAway.Provider key={key} value={away.of(key)}>
              <FoldSlot entryKey={key} gap={gap} style={style}>
                {measuring ? (
                  <View
                    onLayout={(e) => {
                      if (state.current.moving || (state.current.folding && !state.current.kept.has(key))) return;
                      const height = e.nativeEvent.layout.height;
                      setMeasured((all) => (all[key] === height ? all : { ...all, [key]: height }));
                    }}
                  >
                    {node}
                  </View>
                ) : (
                  node
                )}
              </FoldSlot>
            </FoldedAway.Provider>
          );
        })}
        </FoldSettling.Provider>
        {footer}
      </View>
    </Animated.View>
  );
}

const FoldSlot = memo(function FoldSlot({ entryKey, gap, style, children }: { entryKey: string; gap: number; style: object | null; children: ReactNode }) {
  const collapsing = useCollapsingSlot(entryKey, gap);
  return (
    <Animated.View style={collapsing ? [style, collapsing] : style}>
      <FoldEntryContext.Provider value>{children}</FoldEntryContext.Provider>
    </Animated.View>
  );
});
