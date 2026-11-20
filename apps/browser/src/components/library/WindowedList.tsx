import { memo, type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Animated, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, ScrollView, View } from "react-native";
import { assignSlots } from "../pages/historyLayout";
import { reduceMotion } from "../ui";
import { EdgeFade } from "../ui/EdgeFade";
import { noteLibraryListSlide } from "../../state/telemetry/libraryCounts";
import { firstSlotEndingAfter, firstSlotStartingAfter, type Slot, type SlotRows } from "./dayLayout";
import { useLibraryScrollFrame } from "./LibraryScrollEdge";
import { LIBRARY_MOTION } from "./motion";
import { LIBRARY } from "./tokens";

export type WindowedListHandle = { reveal: (key: string, index: number) => void; toTop: () => void };

export type WindowedScroller = { revealSlot: (index: number) => void; toTop: () => void; topSlot: () => number; scrollToSlot: (index: number) => void };

const INITIAL_VIEWPORT = 800;
const LEAD = LIBRARY.list.lead;
const E_FADE = LIBRARY.scrollEdge.fadeReach;
const SLIDE = LIBRARY_MOTION.slide;
const KEPT_SHARE = 0.6;

type Slide = { shift: Animated.Value; appear: Animated.Value; deltas: Map<string, number>; born: Set<string>; at: number };

const slideLeft = (slide: Slide | null, now: number) => (slide ? 1 - SLIDE.easing(Math.min(1, (now - slide.at) / SLIDE.duration)) : 0);

export function WindowedList<T>({
  rows,
  render,
  handle,
  scope,
  restart,
  same,
}: {
  rows: SlotRows<T>;
  render: (item: T, key: string) => ReactNode;
  handle?: Ref<WindowedScroller>;
  scope?: () => unknown;
  restart?: string;
  same?: (a: T, b: T) => boolean;
}) {
  const frame = useLibraryScrollFrame();
  const scrollY = useRef(0);
  const unappliedY = useRef<number | null>(null);
  const restarted = useRef(restart);
  if (restarted.current !== restart) {
    restarted.current = restart;
    scrollY.current = 0;
  }
  const lead = LEAD + frame.inset;
  const height = rows.height + lead;
  const [viewport, setViewport] = useState(INITIAL_VIEWPORT);
  const settledRows = useRef<SlotRows<T> | null>(null);
  const jumped = useRef(false);
  const tight = settledRows.current !== rows || jumped.current;
  const overscan = Math.round(viewport * (tight ? LIBRARY.firstFrameOverscanShare : LIBRARY.overscanShare));

  const [, rerender] = useState(0);
  const range = (y: number) => [firstSlotEndingAfter(rows, y - lead - overscan), firstSlotStartingAfter(rows, y - lead + viewport + overscan)] as const;
  const [from, to] = range(scrollY.current);
  const shown = useRef({ from, to, range });
  shown.current = { from, to, range };
  const scrolledNow = useRef(false);
  const [scrolled, setScrolled] = useState(false);
  const latestFrame = useRef(frame);
  latestFrame.current = frame;
  useEffect(() => () => latestFrame.current.onScrolled(false), []);
  const [onScroll] = useState(() => (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = e.nativeEvent.contentOffset.y;
    if (unappliedY.current !== null && Math.abs(unappliedY.current - scrollY.current) < 1) unappliedY.current = null;
    const past = scrollY.current > 0.5;
    if (past !== scrolledNow.current) {
      latestFrame.current.onScrolled((scrolledNow.current = past));
      setScrolled(past);
    }
    const { from, to, range } = shown.current;
    const [nextFrom, nextTo] = range(scrollY.current);
    if (nextFrom !== from || nextTo !== to) rerender((n) => n + 1);
  });
  const scroller = useRef<ScrollView>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const measured = Math.round(e.nativeEvent.layout.height);
    if (measured <= 0) return;
    setViewport(measured);
    if (unappliedY.current === null) return;
    scroller.current?.scrollTo({ y: unappliedY.current, animated: false });
    unappliedY.current = null;
  }, []);
  const latest = useRef({ rows, viewport, lead, inset: frame.inset });
  latest.current = { rows, viewport, lead, inset: frame.inset };

  useImperativeHandle(
    handle,
    () => ({
      revealSlot: (index: number) => {
        const { rows, viewport, lead, inset } = latest.current;
        if (index < 0 || index >= rows.count) return;
        const entry = rows.at(index);
        const top = entry.top + lead;
        const y = top < scrollY.current + inset ? Math.max(0, top - inset - LIBRARY.list.header) : top + entry.height > scrollY.current + viewport ? top + entry.height - viewport + LIBRARY.list.endPad : null;
        if (y === null) return;
        scrollY.current = y;
        scroller.current?.scrollTo({ y, animated: false });
        rerender((n) => n + 1);
      },
      topSlot: () => {
        const { rows, lead, inset } = latest.current;
        return scrollY.current <= 0.5 ? 0 : firstSlotEndingAfter(rows, scrollY.current - lead + inset);
      },
      scrollToSlot: (index: number) => {
        const { rows, lead, inset } = latest.current;
        if (index < 0 || index >= rows.count) return;
        const y = index === 0 ? 0 : Math.max(0, rows.at(index).top + lead - inset);
        if (Math.abs(y - scrollY.current) > latest.current.viewport) jumped.current = true;
        scrollY.current = y;
        unappliedY.current = y;
        scroller.current?.scrollTo({ y, animated: false });
        const past = y > 0.5;
        if (past !== scrolledNow.current) {
          latestFrame.current.onScrolled((scrolledNow.current = past));
          setScrolled(past);
        }
        rerender((n) => n + 1);
      },
      toTop: () => {
        scrollY.current = 0;
        scroller.current?.scrollTo({ y: 0, animated: false });
        latestFrame.current.onScrolled((scrolledNow.current = false));
        setScrolled(false);
      },
    }),
    [],
  );

  const slots = useRef({ rows, at: new Map<number, Slot<T>>() });
  if (slots.current.rows !== rows) slots.current = { rows, at: new Map() };
  const slotAt = slots.current.at;
  const shownSlots: Slot<T>[] = [];
  for (let i = from; i < to; i++) {
    let slot = slotAt.get(i);
    if (!slot) slotAt.set(i, (slot = rows.at(i)));
    shownSlots.push(slot);
  }
  for (const i of slotAt.keys()) if (i < from || i >= to) slotAt.delete(i);

  const slide = useRef<Slide | null>(null);
  const context = `${String(scope?.() ?? "")}\n${restart ?? ""}`;
  const seen = useRef({ rows, scope: context, count: rows.count, tops: new Map<string, number>() });
  const now = performance.now();
  if (seen.current.rows !== rows) {
    const before = seen.current;
    const started = planSlide(before, shownSlots, rows.count, context);
    if (started) {
      slide.current?.shift.stopAnimation();
      slide.current?.appear.stopAnimation();
      slide.current = { ...started, shift: new Animated.Value(1), appear: new Animated.Value(0), at: now };
    }
  }
  const moving = slide.current;
  const left = slideLeft(moving, now);
  const tops = new Map<string, number>();
  for (const p of shownSlots) tops.set(p.key, p.top + (moving?.deltas.get(p.key) ?? 0) * left);
  seen.current = { rows, scope: seen.current.rows !== rows ? context : seen.current.scope, count: rows.count, tops };

  useEffect(() => {
    const run = slide.current;
    if (!run || run.at !== now) return;
    noteLibraryListSlide();
    const animation = Animated.parallel([
      Animated.timing(run.shift, { toValue: 0, duration: SLIDE.duration, easing: SLIDE.easing, useNativeDriver: true }),
      Animated.timing(run.appear, { toValue: 1, ...LIBRARY_MOTION.content, useNativeDriver: true }),
    ]);
    animation.start(({ finished }) => {
      if (!finished || slide.current !== run) return;
      slide.current = null;
      rerender((n) => n + 1);
    });
  });

  const slotsByPool = useRef(new Map<string, Map<string, number>>());
  const keysByPool = new Map<string, string[]>();
  for (const p of shownSlots) {
    let keys = keysByPool.get(p.pool);
    if (!keys) keysByPool.set(p.pool, (keys = []));
    keys.push(p.key);
  }
  const nextSlots = new Map<string, Map<string, number>>();
  for (const [pool, keys] of keysByPool) nextSlots.set(pool, assignSlots(keys, slotsByPool.current.get(pool) ?? new Map()));
  slotsByPool.current = nextSlots;

  const drawn = useRef(new Map<string, { item: T; render: typeof render; node: ReactNode }>());
  const nextDrawn = new Map<string, { item: T; render: typeof render; node: ReactNode }>();
  const children: ReactNode[] = [];
  for (const p of shownSlots) {
    const slot = nextSlots.get(p.pool)!.get(p.key)!;
    const kept = drawn.current.get(p.key);
    const node = kept && kept.render === render && (kept.item === p.item || (same?.(kept.item, p.item) ?? false)) ? kept.node : render(p.item, p.key);
    nextDrawn.set(p.key, { item: p.item, render, node });
    const delta = moving?.deltas.get(p.key) ?? 0;
    children.push(
      <ListSlot key={`${p.pool}${slot}`} top={p.top + lead} height={p.height} delta={delta} shift={delta ? moving!.shift : null} appear={moving?.born.has(p.key) ? moving.appear : null}>
        {node}
      </ListSlot>,
    );
  }
  drawn.current = nextDrawn;

  useEffect(() => {
    if (!tight) return;
    const frame = requestAnimationFrame(() => {
      settledRows.current = rows;
      jumped.current = false;
      rerender((n) => n + 1);
    });
    return () => cancelAnimationFrame(frame);
  });

  const firstRestart = useRef(true);
  useEffect(() => {
    if (firstRestart.current) return void (firstRestart.current = false);
    scroller.current?.scrollTo({ y: 0, animated: false });
    latestFrame.current.onScrolled((scrolledNow.current = false));
    setScrolled(false);
  }, [restart]);

  useEffect(() => {
    if (scrollY.current > Math.max(0, height - viewport)) {
      scrollY.current = Math.max(0, height - viewport);
      rerender((n) => n + 1);
    }
  }, [height, viewport]);

  return (
    <EdgeFade style={FILL} active={scrolled && frame.inset > 0} fadeHeight={Math.round(frame.inset * E_FADE)}>
      <ScrollView ref={scroller} onLayout={onLayout} onScroll={onScroll} scrollEventThrottle={0} style={FILL}>
        <View style={{ height }}>{children}</View>
      </ScrollView>
    </EdgeFade>
  );
}

function planSlide<T>(
  before: { rows: SlotRows<T>; scope: unknown; count: number; tops: Map<string, number> },
  shownSlots: Slot<T>[],
  count: number,
  scope: unknown,
): Pick<Slide, "deltas" | "born"> | null {
  if (before.scope !== scope || !before.tops.size || reduceMotion() !== false) return null;
  const change = Math.abs(count - before.count);
  if (change === 0 || change > SLIDE.maxRows + 1) return null;
  const deltas = new Map<string, number>();
  const born = new Set<string>();
  let kept = 0;
  for (const p of shownSlots) {
    const was = before.tops.get(p.key);
    if (was === undefined) {
      born.add(p.key);
      continue;
    }
    kept++;
    const delta = was - p.top;
    if (Math.abs(delta) > SLIDE.maxShift) return null;
    if (Math.abs(delta) >= 0.5) deltas.set(p.key, delta);
  }
  if (!deltas.size || kept < shownSlots.length * KEPT_SHARE) return null;
  return { deltas, born };
}

const ListSlot = memo(function ListSlot({
  top,
  height,
  delta,
  shift,
  appear,
  children,
}: {
  top: number;
  height: number;
  delta: number;
  shift: Animated.Value | null;
  appear: Animated.Value | null;
  children: ReactNode;
}) {
  const style = useMemo(
    () => [
      { position: "absolute" as const, left: 0, right: 0, top, height },
      shift ? { transform: [{ translateY: Animated.multiply(shift, delta) }] } : null,
      appear ? { opacity: appear } : null,
    ],
    [top, height, delta, shift, appear],
  );
  return <Animated.View style={style}>{children}</Animated.View>;
});

const FILL = { flex: 1 } as const;
