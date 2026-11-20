import { type ReactNode, type RefObject, useCallback, useMemo, useRef, useState } from "react";
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
import { gridTileSize, LIBRARY } from "./tokens";

const G = LIBRARY.grid;
const L = LIBRARY.list;
const HEADER = { flex: 1, justifyContent: "flex-end", paddingBottom: L.headerBelow } as const;
const ROW = { flexDirection: "row", gap: G.gap, paddingHorizontal: LIBRARY.panel.pad } as const;
const FILL = { flex: 1 } as const;

export function CardGrid<T>({
  windowId,
  groups,
  panelWidth,
  keyOf,
  rowHeight,
  renderCard,
  onOpen,
  entry,
  scroll,
}: {
  windowId: string;
  groups: readonly DayGroup<T>[];
  panelWidth: number;
  keyOf: (item: T) => string;
  rowHeight: (tile: number) => number;
  renderCard: (item: T, tile: number, highlighted: boolean) => ReactNode;
  onOpen: (item: T) => void;
  entry: RefObject<(() => void) | null>;
  scroll?: RefObject<ViewScroll | null>;
}) {
  const tile = gridTileSize(panelWidth);
  const height = rowHeight(tile);
  const layout = useMemo(() => dayLayout(groups, keyOf, { columns: G.columns, header: L.header, untitledGap: G.gap, row: height, rowGap: G.gap, endPad: L.endPad }), [groups, height]);

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
    columns: G.columns,
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
  const render = useCallback(
    (e: DaySlot<T>) =>
      e.kind === "header" ? (
        <View style={HEADER} accessibilityRole="header">
          <SectionLabel title={e.title} inset={LIBRARY.panel.pad} />
        </View>
      ) : (
        <View style={ROW}>{e.items.map((item) => <View key={keyOf(item)}>{renderCard(item, tile, highlighted === keyOf(item))}</View>)}</View>
      ),
    [renderCard, tile, highlighted, keyOf],
  );

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
