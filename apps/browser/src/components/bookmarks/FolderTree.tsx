import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { bookmarkAncestors, folderChildren } from "../../state/bookmarks/bookmarks";
import { useBookmarkRoots, useBookmarks } from "../../state/bookmarks/hooks";
import { currentBookmarkRoots, currentBookmarks } from "../../state/browser/current";
import { radius, space, Symbol, Text, useHover, useTheme } from "../ui";
import { folderTree, folderTreeInk } from "./tokens";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";
import { useRowDrag, type RowDragHandlers } from "./useRowDrag";

type FolderRow = { id: string; title: string; depth: number; hasChildren: boolean };

export type FolderTreeRowInfo = { id: string; depth: number; expanded: boolean };

export type FolderTreeDrag = {
  canDrag: (id: string) => boolean;
  onDragStart: (id: string) => void;
  onDragMove: (x: number, y: number) => void;
  onDragEnd: (x: number, y: number) => void;
};

export const folderTreeRowInset = (depth: number) => folderTree.inset + depth * folderTree.indent;

function useFolderRows(profileId: string, expanded: Set<string>): FolderRow[] {
  const roots = useBookmarkRoots(profileId);
  const key = useBookmarks((b) => {
    if (!roots) return "";
    const lines: string[] = [];
    const walk = (id: string, depth: number) => {
      const node = b.nodes[id];
      if (node?.kind !== "folder") return;
      const sub = folderChildren(b, id).filter((c) => c.kind === "folder");
      lines.push(JSON.stringify([id, node.title, depth, sub.length > 0]));
      if (expanded.has(id)) sub.forEach((c) => walk(c.id, depth + 1));
    };
    walk(roots.bar, 0);
    walk(roots.other, 0);
    return lines.join("\n");
  });
  return useMemo(
    () =>
      key
        ? key.split("\n").map((line) => {
            const [id, title, depth, hasChildren] = JSON.parse(line) as [string, string, number, boolean];
            return { id, title, depth, hasChildren };
          })
        : [],
    [key],
  );
}

export function FolderTree({
  profileId,
  selectedId,
  onSelect,
  rowHeight,
  wrapRow,
  drag,
}: {
  profileId: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  rowHeight: number;
  wrapRow?: (row: FolderTreeRowInfo, content: ReactNode) => ReactNode;
  drag?: FolderTreeDrag;
}) {
  const [expanded, setExpanded] = useState(() => {
    const b = currentBookmarks();
    const roots = currentBookmarkRoots(profileId);
    const open = new Set<string>(roots ? [roots.bar, roots.other] : []);
    if (selectedId) for (const a of bookmarkAncestors(b, selectedId)) open.add(a.id);
    return open;
  });
  useEffect(() => {
    if (!selectedId) return;
    const hidden = bookmarkAncestors(currentBookmarks(), selectedId).filter((a) => !expanded.has(a.id));
    if (hidden.length) setExpanded((prev) => new Set([...prev, ...hidden.map((a) => a.id)]));
  }, [selectedId]);
  const rows = useFolderRows(profileId, expanded);
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <View>
      {rows.map((row) => (
        <FolderTreeRow
          key={row.id}
          row={row}
          height={rowHeight}
          selected={row.id === selectedId}
          expanded={expanded.has(row.id)}
          onToggle={() => toggle(row.id)}
          onSelect={() => onSelect(row.id)}
          wrap={wrapRow}
          drag={drag && drag.canDrag(row.id) ? drag : null}
        />
      ))}
    </View>
  );
}

function FolderTreeRow({
  row,
  height,
  selected,
  expanded,
  onToggle,
  onSelect,
  wrap,
  drag,
}: {
  row: FolderRow;
  height: number;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
  wrap?: (row: FolderTreeRowInfo, content: ReactNode) => ReactNode;
  drag: FolderTreeDrag | null;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(row.hasChildren, buttonMotion.iconPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  const handlers: RowDragHandlers | null = drag && {
    onDragStart: () => drag.onDragStart(row.id),
    onDragMove: drag.onDragMove,
    onDragEnd: drag.onDragEnd,
  };
  const { panHandlers, dy, dragging } = useRowDrag(handlers);
  const content = (
    <View {...hoverProps}>
      <Pressable onPress={onSelect}>
        <View
          style={{
            height,
            borderRadius: radius.control,
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: folderTreeRowInset(row.depth),
            paddingRight: space.m,
            backgroundColor: selected ? theme.formAccent : hovered ? theme.rowHover : undefined,
          }}
        >
          <Pressable
            onPress={onToggle}
            onPressIn={pressMotion.onPressIn}
            onPressOut={pressMotion.onPressOut}
            disabled={!row.hasChildren}
            style={{ width: folderTree.chevronBox, height, alignItems: "center", justifyContent: "center" }}
          >
            {row.hasChildren ? (
              <Animated.View style={[CHEVRON, scaleStyle]}>
                <Symbol
                  name={expanded ? "chevron.down" : "chevron.right"}
                  size={folderTree.chevron}
                  weight="semibold"
                  color={selected ? folderTreeInk.selectedChevron : theme.textSecondary}
                  style={CHEVRON}
                />
              </Animated.View>
            ) : null}
          </Pressable>
          <Symbol name="folder" size={folderTree.folderIcon} color={selected ? theme.onAccent : theme.icon} style={FOLDER_ICON} />
          <Text lines={1} tone={selected ? "onAccent" : "textPrimary"} style={TITLE}>
            {row.title}
          </Text>
        </View>
      </Pressable>
    </View>
  );
  return (
    <Animated.View
      {...panHandlers}
      style={{ zIndex: dragging ? folderTree.draggingLayer : 0, opacity: dragging ? folderTree.dragOpacity : 1, transform: [{ translateY: dy }] }}
    >
      {wrap ? wrap({ id: row.id, depth: row.depth, expanded }, content) : content}
    </Animated.View>
  );
}

const CHEVRON = { width: folderTree.chevronBox, height: folderTree.chevronBox } as const;
const FOLDER_ICON = { width: folderTree.folderBox, height: folderTree.folderBox } as const;
const TITLE = { flex: 1, marginLeft: space.s } as const;
