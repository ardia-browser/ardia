import { memo, type ReactNode, type RefObject, useCallback, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import type { DayGroup } from "../../state/library/items";
import { SectionLabel } from "../sidebar/SectionLabel";
import { CURSOR_KEYS, useLibraryCursor } from "./useLibraryCursor";
import { useLibraryListPointer } from "./useLibraryListPointer";
import { libraryOf } from "../../state/library/library";
import { useLibraryListScope } from "../../state/library/hooks";
import { dayLayout, sameDaySlot, type DaySlot } from "./dayLayout";
import type { ViewScroll } from "./LibraryViewPair";
import { WindowedList, type WindowedListHandle, type WindowedScroller } from "./WindowedList";
import { LIBRARY } from "./tokens";

const L = LIBRARY.list;
const HEADER_INSET = L.inset + L.rowPad;
const HEADER = { flex: 1, justifyContent: "flex-end", paddingBottom: L.headerBelow } as const;
const FILL = { flex: 1 } as const;

const METRICS = { columns: 1, header: L.header, untitledGap: null, row: L.row, rowGap: 0, endPad: L.endPad };

export function DayList<T>({
  windowId,
  groups,
  keyOf,
  renderRow,
  onOpen,
  entry,
  scroll,
}: {
  windowId: string;
  groups: DayGroup<T>[];
  keyOf: (item: T) => string;
  renderRow: (item: T, highlighted: boolean) => ReactNode;
  onOpen: (item: T) => void;
  entry: RefObject<(() => void) | null>;
  scroll?: RefObject<ViewScroll | null>;
}) {
  const layout = useMemo(() => dayLayout(groups, keyOf, METRICS), [groups]);

  const list = useRef<WindowedScroller>(null);
  const focusTarget = useRef<View>(null);
  const latest = useRef({ layout, onOpen });
  latest.current = { layout, onOpen };
  const listHandle = useRef<WindowedListHandle>({
    reveal: (_key, index) => list.current?.revealSlot(latest.current.layout.slotOfItem(index)),
    toTop: () => list.current?.toTop(),
  });
  const cursor = useLibraryCursor({
    windowId,
    keys: layout.keys,
    columns: 1,
    list: listHandle,
    focusTarget,
    onOpen: (key, index) => {
      const item = latest.current.layout.itemOf(key, index);
      if (item !== undefined) latest.current.onOpen(item);
    },
  });
  entry.current = cursor.enter;
  if (scroll)
    scroll.current = {
      topItem: () => latest.current.layout.itemOfSlot(list.current?.topSlot() ?? 0),
      showItem: (index) => list.current?.scrollToSlot(latest.current.layout.slotOfItem(index)),
    };
  const pointer = useLibraryListPointer(windowId);
  const [query] = useState(() => () => libraryOf(windowId).query);
  const restart = useLibraryListScope(windowId);
  const highlighted = cursor.cursor;
  const render = useCallback((e: DaySlot<T>, key: string) => (e.kind === "header" ? <DayHeader title={e.title} /> : renderRow(e.items[0]!, highlighted === key)), [renderRow, highlighted]);

  return (
    <View {...pointer} {...cursor.focus} ref={focusTarget} focusable enableFocusRing={false} keyDownEvents={CURSOR_KEYS} onKeyDown={cursor.onKeyDown} style={FILL}>
      <WindowedList
        rows={layout}
        handle={list}
        scope={query}
        restart={restart}
        same={sameDaySlot}
        render={render}
      />
    </View>
  );
}

const DayHeader = memo(function DayHeader({ title }: { title: string }) {
  return (
    <View style={HEADER} accessibilityRole="header">
      <SectionLabel title={title} inset={HEADER_INSET} />
    </View>
  );
});
