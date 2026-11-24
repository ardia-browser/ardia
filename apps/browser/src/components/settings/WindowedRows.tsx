import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Divider } from "../ui";
import { settingsContent, useSettingsScroll } from "../../state/settings/growingRows";

export const ROW_ESTIMATE = 44;
export const OVERSCAN_ROWS = 10;
export const WINDOW_STEP = 8;
const DIVIDER = StyleSheet.hairlineWidth * 2;

export type ListWindow = { first: number; last: number };

const NOTHING: ListWindow = { first: 0, last: -1 };

export function listWindow(top: number, viewport: number, listTop: number, pitch: number, total: number): ListWindow {
  if (total <= 0) return { first: 0, last: -1 };
  const into = top - listTop;
  const seen = Math.max(viewport, pitch);
  const from = Math.floor(into / pitch) - OVERSCAN_ROWS;
  const to = Math.ceil((into + seen) / pitch) + OVERSCAN_ROWS;
  const first = Math.min(Math.max(0, Math.floor(from / WINDOW_STEP) * WINDOW_STEP), total - 1);
  const last = Math.min(total - 1, Math.max(first, Math.ceil(to / WINDOW_STEP) * WINDOW_STEP));
  return { first, last };
}

export const rowTop = (index: number, rowHeight: number) => index * rowHeight + Math.max(0, index - 1) * DIVIDER;

export const listHeight = (total: number, rowHeight: number) => (total > 0 ? rowTop(total - 1, rowHeight) + (total > 1 ? DIVIDER : 0) + rowHeight : 0);

type Keys = { byIndex: Map<number, number>; next: number };

export function recycledKeys(was: Keys, first: number, last: number): Keys {
  const byIndex = new Map<number, number>();
  const free: number[] = [];
  for (const [index, key] of was.byIndex) {
    if (index >= first && index <= last) byIndex.set(index, key);
    else free.push(key);
  }
  let next = was.next;
  for (let index = first; index <= last; index++) if (!byIndex.has(index)) byIndex.set(index, free.pop() ?? next++);
  return { byIndex, next };
}

type SlotProps<T> = { top: number; height: number; divider: boolean; item: T | undefined; render: (item: T | undefined) => ReactNode; onMeasure?: (e: LayoutChangeEvent) => void };

const Slot = memo(function Slot<T>({ top, height, divider, item, render, onMeasure }: SlotProps<T>) {
  return (
    <View style={[SLOT, { top, height }]}>
      {divider ? <Divider thick inset="l" /> : null}
      <View onLayout={onMeasure}>{render(item)}</View>
    </View>
  );
}) as <T>(props: SlotProps<T>) => ReactNode;

export function WindowedRows<T>({
  count,
  itemAt,
  render,
  onWindow,
}: {
  count: number;
  itemAt: (index: number) => T | undefined;
  render: (item: T | undefined) => ReactNode;
  onWindow?: (first: number, last: number) => void;
}) {
  const [rowHeight, setRowHeight] = useState(ROW_ESTIMATE);
  const [listTop, setListTop] = useState<number | null>(null);
  const box = useRef<View>(null);
  const keys = useRef<Keys>({ byIndex: new Map(), next: 0 });
  const span = useSettingsScroll((s) => {
    const w = listTop === null ? NOTHING : listWindow(s.top, s.viewport, listTop, rowHeight + DIVIDER, count);
    return `${w.first}:${w.last}`;
  });
  const contentHeight = useSettingsScroll((s) => s.content);
  const [first, last] = span.split(":").map(Number) as [number, number];
  useEffect(() => {
    if (last >= first) onWindow?.(first, last);
  }, [first, last, onWindow]);
  const place = useCallback(() => {
    const content = settingsContent.current;
    if (!content || !box.current) return;
    box.current.measureLayout(content, (_x, y) => setListTop((was) => (was !== null && Math.abs(was - y) < 0.5 ? was : y)), () => undefined);
  }, []);
  useEffect(place, [contentHeight, count]);
  const measure = useCallback((e: LayoutChangeEvent) => {
    const height = e.nativeEvent.layout.height;
    if (height > 0) setRowHeight((was) => (Math.abs(height - was) >= 0.5 ? height : was));
  }, []);

  const placed = recycledKeys(keys.current, first, last);
  keys.current = placed;
  const shown: ReactNode[] = [];
  let measuring = false;
  for (let index = first; index <= last; index++) {
    const item = itemAt(index);
    const measures: boolean = item !== undefined && !measuring;
    measuring ||= measures;
    shown.push(
      <Slot
        key={placed.byIndex.get(index)}
        top={rowTop(index, rowHeight)}
        height={index > 0 ? rowHeight + DIVIDER : rowHeight}
        divider={index > 0}
        item={item}
        render={render}
        onMeasure={measures ? measure : undefined}
      />,
    );
  }
  return (
    <View ref={box} collapsable={false} onLayout={place} style={{ height: Math.max(listHeight(count, rowHeight), count > 0 ? rowHeight : 0) }}>
      {shown}
    </View>
  );
}

const SLOT = { position: "absolute", left: 0, right: 0 } as const;
