import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, ScrollView, View } from "react-native";
import type { RemovedBookmarks } from "../../state/bookmarks/bookmarks";
import { useTab } from "../../state/browser/hooks";
import { currentBookmarks } from "../../state/browser/current";
import { useBookmarkRoots, useBookmarks } from "../../state/bookmarks/hooks";
import { plural } from "../../state/browser/model";
import { moveBookmarks, openFolder, openUrl, removeBookmarks, restoreBookmarks } from "../../state/bookmarks/actions";
import { clickSelection, rowWindow, selectedInOrder } from "../../state/bookmarks/bookmarkList";
import { NO_ROWS_SELECTED } from "../../state/history/historySelection";
import { FolderTree } from "../bookmarks/FolderTree";
import { bookmarkDrag } from "../bookmarks/tokens";
import { Box, Button, Divider, EmptyState, radius, space, Text, Toast, useTheme } from "../ui";
import { openBookmarkRowMenu, openOrganizeMenu } from "../../state/bookmarks/bookmarkMenus";
import { BookmarkRow } from "./BookmarkRow";
import { listedBookmarks } from "./bookmarkResults";
import { DropTargets } from "./dropTargets";
import { notePageScroll, PageHeader } from "./PageLayout";
import { menuRows, revealOffset } from "./listCursor";
import { useListCursor } from "./useListCursor";
import { bookmarkList, pagesColors, undoToast } from "./tokens";
import { commandHeld } from "../../state/commands/keyNotation";


type Target = { kind: "folder"; id: string } | { kind: "row"; id: string; index: number; folder: boolean };
type Drop = { into: string } | { parentId: string; index: number };

export function BookmarksPage({ tabId, profileId }: { tabId: string; profileId: string }) {
  const theme = useTheme();
  const colors = pagesColors(theme);
  const windowId = useTab(tabId, (t) => t?.windowId ?? "");
  const roots = useBookmarkRoots(profileId);
  const [folderId, setFolderId] = useState<string | null>(roots?.bar ?? null);
  const [query, setQuery] = useState("");
  const [undo, setUndo] = useState<{ removed: RemovedBookmarks; count: number } | null>(null);
  const [undoClosing, setUndoClosing] = useState(false);
  const [drop, setDrop] = useState<Drop | null>(null);
  const targets = useMemo(() => new DropTargets<Target>(), []);

  const folderExists = useBookmarks((b) => !!folderId && b.nodes[folderId]?.kind === "folder");
  useEffect(() => {
    if (!folderExists && roots) setFolderId(roots.bar);
  }, [folderExists, roots]);

  const folderTitle = useBookmarks((b) => (folderId ? (b.nodes[folderId]?.title ?? "") : ""));
  const ids = useBookmarks(useMemo(() => listedBookmarks(roots, folderId, query), [roots, folderId, query]));
  const searching = !!query.trim();
  const { selection, setSelection, cursor, list, listProps, enter } = useListCursor(ids, {
    open: (id) => {
      const node = currentBookmarks().nodes[id];
      if (node?.kind === "folder") openFolderAt(id);
      else if (node) openUrl(node.url, windowId, "current");
    },
    menu: (id) => openRowMenu(id),
    remove: () => remove(selected),
  });
  useEffect(() => setSelection(NO_ROWS_SELECTED), [folderId, query]);
  const selected = useMemo(() => selectedInOrder(ids, selection), [ids, selection]);

  const select = (id: string, e: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) => {
    setSelection((current) => ({ ...clickSelection(ids, current, id, { shiftKey: e.shiftKey, metaKey: commandHeld(e) }), cursor: id }));
    list.current?.focus();
  };

  const remove = (doomed: string[]) => {
    if (!doomed.length) return;
    const removed = removeBookmarks(doomed);
    setSelection((current) => ({ ...current, selected: new Set() }));
    setUndo({ removed, count: removed.places.length });
    setUndoClosing(false);
  };
  const openFolderAt = (folder: string) => {
    setQuery("");
    setFolderId(folder);
  };
  const openRowMenu = (id: string) => {
    const node = currentBookmarks().nodes[id];
    if (!node) return;
    const picked = menuRows(ids, selection, id);
    if (!selection.selected.has(id)) select(id, {});
    void openBookmarkRowMenu(node, { windowId, profileId, showPath: searching, selection: picked, onOpenFolder: (folder = id) => openFolderAt(folder), onDelete: () => remove(picked) });
  };
  const undoRemove = () => {
    if (!undo) return;
    restoreBookmarks(undo.removed);
    setUndo(null);
  };

  const [viewport, setViewport] = useState(800);
  const [scrollY, setScrollY] = useState(0);
  const onListLayout = useCallback((e: LayoutChangeEvent) => setViewport(Math.max(bookmarkList.row, Math.round(e.nativeEvent.layout.height))), []);
  const onListScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    notePageScroll();
    setScrollY(e.nativeEvent.contentOffset.y);
  }, []);
  const shown = rowWindow(ids.length, bookmarkList.row, scrollY, viewport);
  const scroller = useRef<ScrollView>(null);
  useEffect(() => {
    const index = cursor ? ids.indexOf(cursor) : -1;
    const y = index < 0 ? null : revealOffset(index * bookmarkList.row, bookmarkList.row + 2 * LIST_CONTENT.padding, scrollY, viewport);
    if (y !== null) scroller.current?.scrollTo({ y, animated: false });
  }, [cursor, viewport]);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndoClosing(true), undoToast.visibleMs);
    return () => clearTimeout(timer);
  }, [undo]);

  const dragging = useRef<string[]>([]);
  const onDragStart = (id: string) => {
    dragging.current = selection.selected.has(id) ? selected : [id];
    targets.measure();
  };
  const dropFor = (x: number, y: number): Drop | null => {
    const hit = targets.hit(x, y);
    if (!hit || !folderId) return null;
    const t = hit.data;
    if (t.kind === "folder") return dragging.current.includes(t.id) ? null : { into: t.id };
    if (t.folder && hit.fraction > 0.25 && hit.fraction < 0.75 && !dragging.current.includes(t.id)) return { into: t.id };
    if (searching) return null;
    return { parentId: folderId, index: hit.fraction < 0.5 ? t.index : t.index + 1 };
  };
  const onDragMove = (x: number, y: number) => {
    const next = dropFor(x, y);
    setDrop((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  };
  const onDragEnd = (x: number, y: number) => {
    const target = dropFor(x, y);
    setDrop(null);
    if (!target) return;
    const moving = dragging.current;
    if ("into" in target) return moveBookmarks(moving, target.into);
    const picked = new Set(moving);
    let index = target.index;
    for (let at = 0; at < target.index && at < ids.length; at++) if (picked.has(ids[at]!)) index--;
    moveBookmarks(moving, target.parentId, index);
  };

  const actions =
    selected.length > 0 ? (
      <>
        <Text size="small" tone="textSecondary">{`${selected.length} selected`}</Text>
        <Button title="Remove" kind="primary" onPress={() => remove(selected)} />
      </>
    ) : (
      <Button variant="icon" icon="ellipsis.circle" onPress={() => void openOrganizeMenu(windowId, profileId, folderId)} tooltip="Organize" />
    );

  const indicator = drop && "index" in drop ? drop.index : null;

  return (
    <View style={{ flex: 1 }}>
      <PageHeader title="Bookmarks" query={query} onQuery={setQuery} actions={actions} onArrow={enter} />
      <View style={BODY}>
        <ScrollView style={TREE} contentContainerStyle={TREE_CONTENT}>
          <FolderTree
            profileId={profileId}
            selectedId={searching ? null : folderId}
            onSelect={(id) => {
              setQuery("");
              setFolderId(id);
            }}
            rowHeight={bookmarkList.treeRow}
            wrapRow={(id, row) => (
              <View
                ref={targets.ref(`tree:${id}`, { kind: "folder", id })}
                style={{ borderRadius: radius.control, backgroundColor: drop && "into" in drop && drop.into === id ? colors.dropTarget : undefined }}
              >
                {row}
              </View>
            )}
          />
        </ScrollView>
        <Box radius="panel" fill="groupFill" border="groupBorder" style={LIST_CARD}>
          <Box row padX="xl" gap="m" style={LIST_HEADER}>
            <Text lines={1} weight="semibold" style={LIST_TITLE}>
              {searching ? `Results for “${query.trim()}”` : folderTitle}
            </Text>
            {!searching && folderId && (
              <Button title="Open All" onPress={() => void openFolder(folderId, windowId)} disabled={!ids.length} />
            )}
          </Box>
          <Divider thick />
          {ids.length === 0 ? (
            <EmptyState
              symbol={searching ? "magnifyingglass" : "bookmark"}
              title={searching ? "No results" : "This folder is empty"}
            />
          ) : (
            <View {...listProps} style={LIST_KEYS_VIEW}>
              <ScrollView ref={scroller} onLayout={onListLayout} onScroll={onListScroll} scrollEventThrottle={16} contentContainerStyle={LIST_CONTENT}>
                <View style={{ height: ids.length * bookmarkList.row }}>
                  {ids.slice(shown.first, shown.end).map((id, offset) => {
                    const index = shown.first + offset;
                    return (
                      <BookmarkRow
                        key={id}
                        id={id}
                        top={index * bookmarkList.row}
                        windowId={windowId}
                        profileId={profileId}
                        showPath={searching}
                        selected={selection.selected.has(id)}
                        highlighted={!!drop && "into" in drop && drop.into === id}
                        keyboardRow={cursor === id}
                        targetRef={targets.ref(`row:${id}`, { kind: "row", id, index, folder: currentBookmarks().nodes[id]?.kind === "folder" })}
                        onSelect={(e) => select(id, e)}
                        onOpenFolder={() => openFolderAt(id)}
                        onMenu={() => openRowMenu(id)}
                        onDragStart={() => onDragStart(id)}
                        onDragMove={onDragMove}
                        onDragEnd={onDragEnd}
                      />
                    );
                  })}
                  {indicator !== null && <DropLine top={indicator * bookmarkList.row} color={theme.accent} />}
                </View>
              </ScrollView>
            </View>
          )}
        </Box>
      </View>
      {undo && (
        <Toast
          title={`${plural(undo.count, "item")} removed`}
          action="Undo"
          onAction={undoRemove}
          closing={undoClosing}
          onClosed={() => setUndo(null)}
        />
      )}
    </View>
  );
}

function DropLine({ top, color }: { top: number; color: string }) {
  return <View style={[DROP_LINE, { top: top - bookmarkDrag.line / 2, backgroundColor: color }]} />;
}

const BODY = { flex: 1, flexDirection: "row", paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.xl } as const;
const TREE = { width: bookmarkList.treeWidth, flexGrow: 0 } as const;
const TREE_CONTENT = { paddingVertical: space.xs } as const;
const LIST_CARD = { flex: 1, overflow: "hidden" } as const;
const LIST_HEADER = { height: bookmarkList.headerHeight, alignItems: "center" } as const;
const LIST_TITLE = { flex: 1 } as const;
const LIST_KEYS_VIEW = { flex: 1 } as const;
const LIST_CONTENT = { padding: space.s } as const;
const DROP_LINE = { position: "absolute", left: space.m, right: space.m, height: bookmarkDrag.line, borderRadius: bookmarkDrag.lineRadius, zIndex: 5 } as const;
