import { type RefObject, useEffect, useRef, useState } from "react";
import type { NativeSyntheticEvent, View, ViewProps } from "react-native";
import { closeLibrary } from "../../state/library/actions";
import { libraryOf } from "../../state/library/library";
import { useLibraryFocus, type LibraryFocusHandlers } from "./useLibraryFocus";
import { plainKey, type LibraryKeyPress } from "./libraryKeys";
import type { ItemKeys } from "./dayLayout";
import type { WindowedListHandle } from "./WindowedList";

export const CURSOR_KEYS = [{ key: "ArrowDown" }, { key: "ArrowUp" }, { key: "ArrowLeft" }, { key: "ArrowRight" }, { key: "Enter" }, { key: " " }, { key: "Escape" }];

export type LibraryCursor = {
  cursor: string | null;
  onKeyDown: ViewProps["onKeyDown"];
  enter: () => void;
  focus: LibraryFocusHandlers;
};

export function useLibraryCursor({
  windowId,
  keys,
  columns,
  list,
  focusTarget,
  onOpen,
}: {
  windowId: string;
  keys: ItemKeys;
  columns: number;
  list: RefObject<WindowedListHandle | null>;
  focusTarget: RefObject<View | null>;
  onOpen: (key: string, index: number) => void;
}): LibraryCursor {
  const [cursor, setCursor] = useState<string | null>(null);
  const at = useRef(-1);
  const latest = useRef({ keys, cursor, onOpen, columns });
  latest.current = { keys, cursor, onOpen, columns };
  const focus = useLibraryFocus();

  const indexOfCursor = (keys: ItemKeys, cursor: string | null) => {
    if (cursor === null) return -1;
    if (keys.at(at.current) !== cursor) at.current = keys.indexOf(cursor);
    return at.current;
  };

  useEffect(() => {
    if (cursor !== null && indexOfCursor(keys, cursor) < 0) setCursor(null);
  }, [keys]);

  const move = (step: number) => {
    const { keys, cursor } = latest.current;
    if (!keys.length) return;
    const from = indexOfCursor(keys, cursor);
    const next = from < 0 ? 0 : Math.max(0, Math.min(keys.length - 1, from + step));
    const key = keys.at(next)!;
    at.current = next;
    latest.current.cursor = key;
    setCursor(key);
    list.current?.reveal(key, next);
  };

  const [onKeyDown] = useState<ViewProps["onKeyDown"]>(() => ({ nativeEvent }: NativeSyntheticEvent<LibraryKeyPress>) => {
    if (!libraryOf(windowId).open) return;
    const key = plainKey(nativeEvent);
    const { columns } = latest.current;
    if (key === "Escape") closeLibrary(windowId, "escape");
    else if (key === "ArrowDown") move(columns);
    else if (key === "ArrowUp") move(-columns);
    else if (key === "ArrowRight" && columns > 1) move(1);
    else if (key === "ArrowLeft" && columns > 1) move(-1);
    else if (key === "Enter" || key === " ") {
      const { keys, cursor, onOpen } = latest.current;
      if (cursor !== null) onOpen(cursor, indexOfCursor(keys, cursor));
    }
  });

  const enter = () => {
    focusTarget.current?.focus();
    setCursor(null);
    latest.current.cursor = null;
    move(1);
  };

  return { cursor, onKeyDown, enter, focus };
}
