import { suggestionKey, type SearchScope, type Suggestion } from "@ardia/core";
import { useLayoutEffect, useRef, useState } from "react";
import type { Disposition } from "../../state/omnibox/openFromBar";
import type { BarEvent } from "./barText";
import { noteHeldRowsKeyMove } from "../../state/telemetry/inlineCompletionCounts";

export type Held = { items: Suggestion[]; typed: string; scope: SearchScope | null; key: string | null };

const rowIdentity = (row: Suggestion) => ("tabId" in row && row.tabId ? `tab:${row.tabId}` : suggestionKey(row));

export function heldIndex(prev: Held | null, items: Suggestion[], typed: string, scope: SearchScope | null, selectedIndex: number): number {
  if (!prev?.key || prev.items === items || prev.typed !== typed || prev.scope !== scope) return selectedIndex;
  const current = items[selectedIndex];
  if (current && rowIdentity(current) === prev.key) return selectedIndex;
  const at = items.findIndex((s) => rowIdentity(s) === prev.key);
  return at >= 0 ? at : selectedIndex;
}

export function heldKey(items: Suggestion[], selectedIndex: number, typed: string): string | null {
  const current = items[selectedIndex];
  if (!current) return null;
  return selectedIndex === 0 && typed.trim() ? null : rowIdentity(current);
}

export const followedRow = (prev: Held | null, index: number): Held | null => (prev ? { ...prev, key: heldKey(prev.items, index, prev.typed) } : prev);

export function useHeldSelection(items: Suggestion[], typed: string, scope: SearchScope | null, selectedIndex: number, dispatch: (e: BarEvent) => void, rows: { held: boolean; release: () => void }) {
  const held = useRef<Held | null>(null);
  const latestRows = useRef(rows);
  useLayoutEffect(() => {
    latestRows.current = rows;
  });
  useLayoutEffect(() => {
    const at = heldIndex(held.current, items, typed, scope, selectedIndex);
    if (at !== selectedIndex) return dispatch({ kind: "selected", index: at });
    held.current = { items, typed, scope, key: heldKey(items, selectedIndex, typed) };
  });
  const [releaseTo] = useState(() => (followIndex?: number) => {
    if (followIndex !== undefined && latestRows.current.held) {
      held.current = followedRow(held.current, followIndex);
      noteHeldRowsKeyMove();
    }
    latestRows.current.release();
  });
  return releaseTo;
}

export function useProviderEnter(items: Suggestion[], typed: string, scope: SearchScope | null, choose: (s: Suggestion, disposition: Disposition) => void) {
  const pending = useRef<{ typed: string; scope: SearchScope; disposition: Disposition } | null>(null);
  const latest = useRef(choose);
  latest.current = choose;
  useLayoutEffect(() => {
    const wait = pending.current;
    if (!wait) return;
    if (wait.typed !== typed || wait.scope !== scope) {
      pending.current = null;
      return;
    }
    const first = items[0];
    if (first?.kind !== "provider") return;
    pending.current = null;
    latest.current(first, wait.disposition);
  }, [items, typed, scope]);
  return (disposition: Disposition): boolean => {
    if (scope?.kind !== "provider" || !typed.trim()) return false;
    pending.current = { typed, scope, disposition };
    return true;
  };
}
