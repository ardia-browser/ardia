import { useLayoutEffect, useReducer, useRef, useState } from "react";
import { noteRowsHeldUnderPointer } from "../../state/telemetry/inlineCompletionCounts";

type SteadyList<V> = { key: string; value: V };

const sameRows = <T,>(a: T[], b: T[], rowKey: (row: T) => string) => a.length === b.length && a.every((row, i) => rowKey(row) === rowKey(b[i]!));

export function steadyRows<T, V extends { items: T[] }>(shown: SteadyList<V> | null, value: V, key: string, holding: boolean, rowKey: (row: T) => string): SteadyList<V> {
  if (holding && shown && shown.key === key && shown.value.items.length > 0 && !sameRows(shown.value.items, value.items, rowKey)) return shown;
  return { key, value };
}

export function useSteadyRows<T, V extends { items: T[] }>(value: V, key: string, pointerOver: boolean, rowKey: (row: T) => string) {
  const shown = useRef<SteadyList<V> | null>(null);
  const freed = useRef<string | null>(null);
  const counted = useRef<string | null>(null);
  const drawn = useRef({ key, held: false });
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const free = pointerOver && freed.current === key;
  const next = steadyRows(shown.current, value, key, pointerOver && !free, rowKey);
  const held = next.value !== value;
  useLayoutEffect(() => {
    shown.current = next;
    drawn.current = { key, held };
    if (!free) freed.current = null;
    if (held && counted.current !== key) {
      counted.current = key;
      noteRowsHeldUnderPointer();
    }
  });
  const [release] = useState(() => () => {
    freed.current = drawn.current.key;
    if (!drawn.current.held) return;
    shown.current = null;
    redraw();
  });
  return { value: next.value, held, release };
}
