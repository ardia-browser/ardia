import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Animated, Pressable, View } from "react-native";
import { bookmarkAncestors, folderChildren } from "../../state/bookmarks/bookmarks";
import { useBookmarkRoots, useBookmarks } from "../../state/bookmarks/hooks";
import { currentBookmarkRoots, currentBookmarks } from "../../state/browser/current";
import { radius, space, Symbol, Text, useHover, useTheme } from "../ui";
import { folderTree, folderTreeInk } from "./tokens";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";
import { chosenButtonA11y, tapActivates } from "../ui/a11y";

type FolderRow = { id: string; title: string; depth: number; hasChildren: boolean };

export type FolderTreeLook = "accent" | "soft";

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
  rowGap = 0,
  look = "accent",
  wrapRow,
}: {
  profileId: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  rowHeight: number;
  rowGap?: number;
  look?: FolderTreeLook;
  wrapRow?: (id: string, row: ReactNode) => ReactNode;
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
    <View style={{ gap: rowGap }}>
      {rows.map((row) => {
        const content = (
          <FolderTreeRow
            key={row.id}
            row={row}
            height={rowHeight}
            look={look}
            selected={row.id === selectedId}
            expanded={expanded.has(row.id)}
            onToggle={() => toggle(row.id)}
            onSelect={() => onSelect(row.id)}
          />
        );
        return wrapRow ? <View key={row.id}>{wrapRow(row.id, content)}</View> : content;
      })}
    </View>
  );
}

function FolderTreeRow({
  row,
  height,
  look,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  row: FolderRow;
  height: number;
  look: FolderTreeLook;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(row.hasChildren, buttonMotion.iconPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  const soft = look === "soft";
  const filled = selected && !soft;
  return (
    <View {...hoverProps}>
      <Pressable onPress={onSelect} onAccessibilityTap={tapActivates(onSelect)} {...chosenButtonA11y(selected, row.title)}>
        <View
          style={{
            height,
            borderRadius: soft ? radius.tile : radius.control,
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: folderTree.inset + row.depth * folderTree.indent,
            paddingRight: soft ? folderTree.checkInset : space.m,
            backgroundColor: selected ? (soft ? theme.rowSelected : theme.formAccent) : hovered ? theme.rowHover : undefined,
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
                  color={filled ? folderTreeInk.selectedChevron : theme.textSecondary}
                  style={CHEVRON}
                />
              </Animated.View>
            ) : null}
          </Pressable>
          <Symbol name="folder" size={folderTree.folderIcon} color={filled ? theme.onAccent : theme.icon} style={FOLDER_ICON} />
          <Text lines={1} tone={filled ? "onAccent" : "textPrimary"} ardiaCentersCapitals style={TITLE}>
            {row.title}
          </Text>
          {soft && selected ? <Symbol name="checkmark" size={folderTree.check} weight="semibold" color={theme.textPrimary} style={CHECK} /> : null}
        </View>
      </Pressable>
    </View>
  );
}

export function FolderTreeAction({ title, icon, height, onPress }: { title: string; icon: string; height: number; onPress: () => void }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} onAccessibilityTap={tapActivates(onPress)} accessibilityRole="button" accessibilityLabel={title}>
        {({ pressed }) => (
          <View
            style={{
              height,
              borderRadius: radius.tile,
              flexDirection: "row",
              alignItems: "center",
              paddingLeft: folderTree.inset + folderTree.chevronBox,
              paddingRight: space.m,
              backgroundColor: pressed ? theme.popoverRowPressed : hovered ? theme.rowHover : undefined,
            }}
          >
            <Symbol name={icon} size={folderTree.plus} weight="medium" color={theme.textSecondary} style={FOLDER_ICON} />
            <Text lines={1} tone="textSecondary" ardiaCentersCapitals style={TITLE}>
              {title}
            </Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

const CHEVRON = { width: folderTree.chevronBox, height: folderTree.chevronBox } as const;
const CHECK = { width: folderTree.checkBox, height: folderTree.checkBox } as const;
const FOLDER_ICON = { width: folderTree.folderBox, height: folderTree.folderBox } as const;
const TITLE = { flex: 1, marginLeft: space.s } as const;
