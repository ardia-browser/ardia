import { memo } from "react";
import { Pressable, View } from "react-native";
import { modifiersOf } from "../../lib/keys";
import type { HistoryEntry } from "../../state/browser/types";
import { openModeFor, openUrl } from "../../state/bookmarks/actions";
import { Favicon } from "../favicon/Favicon";
import { Checkbox, ContextMenuArea, Divider, HoverSlot, MouseArea, radius, space, Text, useTheme } from "../ui";
import { openHistoryRowMenu } from "../../state/history/historyMenus";
import { hostLabel, RowMenuSlot, timeLabel, useRowControls } from "./PageLayout";
import { historyRow, pagesColors, pageType } from "./tokens";

const DAY_HEADER = { position: "absolute", left: 0, right: 0, height: historyRow.header, justifyContent: "flex-end", paddingBottom: space.m, paddingHorizontal: historyRow.headerInset } as const;
const ROW_FRAME = { height: historyRow.height, paddingHorizontal: space.xl } as const;
const TIME = { width: historyRow.timeWidth } as const;
const LINK = { flexDirection: "row", alignItems: "center", gap: space.ml } as const;
const TITLE = { flexShrink: 1 } as const;
const HOST = { flexShrink: 0, maxWidth: historyRow.hostMaxWidth } as const;
const SEPARATOR = { position: "absolute", left: space.xl + space.l, right: space.xl + space.l, bottom: 0 } as const;

export const DayHeader = memo(function DayHeader({ label, top }: { label: string; top: number }) {
  useTheme();
  return (
    <View style={[DAY_HEADER, { top }]}>
      <Text weight="semibold" tone="textSecondary" style={pageType.dayHeader}>
        {label}
      </Text>
    </View>
  );
});

export const HistoryRow = memo(function HistoryRow({
  entry,
  profileId,
  first,
  last,
  selected,
  highlighted,
  selecting,
  windowId,
  onToggle,
  onMoreFromSite,
  onRemove,
  menuTargets,
}: {
  entry: HistoryEntry;
  profileId: string;
  first: boolean;
  last: boolean;
  selected: boolean;
  highlighted: boolean;
  selecting: boolean;
  windowId: string;
  onToggle: (url: string, shift: boolean) => void;
  onMoreFromSite: (url: string) => void;
  onRemove: (urls: string[]) => void;
  menuTargets: (entry: HistoryEntry) => HistoryEntry[];
}) {
  const theme = useTheme();
  const { hovered, controlsShown: showControls, rowProps } = useRowControls(entry.url, highlighted);
  const menu = () => openHistoryRowMenu(menuTargets(entry), windowId, onMoreFromSite, onRemove);
  const r = radius.panel;
  return (
    <View {...rowProps} style={ROW_FRAME}>
      <ContextMenuArea onContextMenu={() => void menu()} style={{ flex: 1 }}>
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: space.l,
            gap: space.l,
            backgroundColor: selected ? pagesColors(theme).rowSelected : hovered || highlighted ? theme.rowHover : theme.groupFill,
            borderTopLeftRadius: first ? r : 0,
            borderTopRightRadius: first ? r : 0,
            borderBottomLeftRadius: last ? r : 0,
            borderBottomRightRadius: last ? r : 0,
          }}
        >
          <HoverSlot hovered={showControls || selecting} width={historyRow.checkbox} hover={<Checkbox value={selected} focusable accessibilityLabel={entry.title || entry.url} onChange={(_, modifiers) => onToggle(entry.url, !!modifiers?.shiftKey)} />} />
          <Text size="small" tone="textSecondary" style={TIME}>
            {timeLabel(entry.lastVisit)}
          </Text>
          <MouseArea style={{ flex: 1 }} onMiddleClick={() => openUrl(entry.url, windowId, "background")}>
            <Pressable
              focusable={false}
              onPress={(e) => {
                const modifiers = modifiersOf(e);
                if (selecting) return onToggle(entry.url, modifiers.shiftKey);
                openUrl(entry.url, windowId, openModeFor(modifiers));
              }}
              accessibilityActions={[
                { name: "select", label: selected ? "Deselect" : "Select" },
                { name: "menu", label: "More Actions" },
              ]}
              onAccessibilityAction={(e) => {
                if (e.nativeEvent.actionName === "select") onToggle(entry.url, false);
                if (e.nativeEvent.actionName === "menu") void menu();
              }}
              style={LINK}
            >
              <Favicon url={entry.url} favicon={entry.favicon} profileId={profileId} />
              <Text lines={1} style={TITLE}>
                {entry.title || entry.url}
              </Text>
              <Text lines={1} size="small" tone="textTertiary" style={HOST}>
                {hostLabel(entry.url)}
              </Text>
            </Pressable>
          </MouseArea>
          <RowMenuSlot shown={showControls} onPress={() => void menu()} />
        </View>
      </ContextMenuArea>
      {!last && <Divider thick style={SEPARATOR} />}
    </View>
  );
});
