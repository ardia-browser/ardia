import { useEffect, useRef, useState } from "react";
import { findNodeHandle, type View, type ViewProps } from "react-native";
import { NO_ROWS_SELECTED, shownRows, type RowSelection } from "../../state/history/historySelection";
import { cursorRow, enteredCursor, LIST_KEYS, LIST_KEYS_WITH_ESCAPE, listCommand, selectionAfter, startedCursor } from "./listCursor";

export type ListCursorActions = { open: (row: string) => void; menu: (row: string) => void; remove: () => void };

type OwnEvent = { target?: unknown; currentTarget?: unknown };

const fromList = ({ target, currentTarget }: OwnEvent) => target == null || target === currentTarget || target === findNodeHandle(currentTarget as never);

export function useListCursor(keys: readonly string[], actions: ListCursorActions) {
  const [selection, setSelection] = useState<RowSelection>(NO_ROWS_SELECTED);
  const list = useRef<View>(null);
  const latest = useRef({ keys, selection, actions });
  latest.current = { keys, selection, actions };
  useEffect(() => setSelection((prev) => shownRows(keys, prev)), [keys]);

  const onKeyDown: ViewProps["onKeyDown"] = (e) => {
    if (!fromList(e)) return;
    const { keys, selection, actions } = latest.current;
    const command = listCommand(e.nativeEvent, selection.selected.size > 0);
    if (!command) return;
    e.preventDefault();
    const row = cursorRow(keys, selection);
    if (command === "open") return row ? actions.open(row) : undefined;
    if (command === "menu") return row ? actions.menu(row) : undefined;
    if (command === "remove") return selection.selected.size ? actions.remove() : undefined;
    setSelection((prev) => selectionAfter(command, latest.current.keys, prev));
  };
  const onFocus = (e: OwnEvent) => {
    if (fromList(e)) setSelection((prev) => startedCursor(latest.current.keys, prev));
  };
  const enter = (step: 1 | -1) => {
    if (step !== 1 || !keys.length) return;
    list.current?.focus();
    setSelection((prev) => enteredCursor(latest.current.keys, prev));
  };
  const listProps = {
    ref: list,
    focusable: true,
    enableFocusRing: false,
    keyDownEvents: selection.selected.size ? LIST_KEYS_WITH_ESCAPE : LIST_KEYS,
    onKeyDown,
    onFocus,
  };
  return { selection, setSelection, cursor: cursorRow(keys, selection), list, listProps, enter };
}
