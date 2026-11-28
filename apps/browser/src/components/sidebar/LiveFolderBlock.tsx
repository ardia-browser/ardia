import { memo, useMemo, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { errorText, manualRefresh, statusText } from "../../state/live/engine";
import { folderRows, type FolderRow } from "../../state/live/rows";
import { updateFolder, useLive } from "../../state/live/store";
import { hideShownTabs } from "../../state/live/shownTabs";
import type { LiveItem } from "../../state/live/types";
import { usePageProfileId } from "../../state/browser/hooks";
import { noteLiveFolderHeaderHide } from "../../state/telemetry/usage";
import { useLiveFolderKeep, useLiveStrays } from "../../state/sidebar/hooks";
import { Badge, Button, ContextMenuArea, clippedContinuousCorners, Dot, ink, space, Symbol, useHover } from "../ui";
import { layout, useTheme } from "../ui/theme";
import { useLiveColors } from "../live/tokens";
import { TabRow } from "./TabRow";
import { Fold, useFold, type FoldEntry } from "./Fold";
import { GROUP_BORDER, GROUP_INNER_RADIUS, GROUP_RADIUS, LIVE_FOLDER_BOX_PAD, LIVE_FOLDER_HEADER_MARGIN, LIVE_FOLDER_PAD } from "./geometry";
import { useDragFolded, useDragItem } from "./DragProvider";
import { dismissHover } from "../../state/sidebar/hover";
import { useGroupHover } from "./hoverController";
import { useHoverFade } from "./hoverMotion";
import { Squish, useSquish } from "../ui/Squish";
import { iconButton } from "../ui/tokens";
import { REFRESH_ARROW_RING_OFFSET } from "../../lib/platformChrome";
import { iconName } from "../../lib/activeLook";
import { fixLiveFolderError, openLiveFolderMenu } from "../../state/sidebar/liveMenus";
import { registerRow } from "../../state/sidebar/sidebarUi";
import { LiveFolderIcon } from "./LiveFolderIcon";
import { groupBoxAtRest, groupSurface, TAB_ROW, useSidebarTokens } from "./tokens";
import { RefreshSpinner } from "./RefreshSpinner";
import { SidebarRowSurface } from "./SidebarRow";
import { FolderHeaderTitle } from "./FolderHeaderTitle";
import { MoreRow, NoteRow, SectionTitle, StackRow } from "./LiveFolderRows";
import { LiveItemRow } from "./LiveItemRow";
import { CompletedFooter, useCompletedShown } from "./CompletedFooter";
import { entryKey } from "../../state/sidebar/entryKey";

const PAD = LIVE_FOLDER_PAD;
const EMPTY: LiveItem[] = [];
const NONE: string[] = [];
const HEADER_ROOM = { marginHorizontal: LIVE_FOLDER_HEADER_MARGIN } as const;
const BOX_ROOM = { paddingVertical: GROUP_BORDER, paddingHorizontal: LIVE_FOLDER_BOX_PAD } as const;
const REFRESH_SLOT = { minWidth: iconButton.s.box, alignSelf: "stretch", flexDirection: "row", alignItems: "center", justifyContent: "flex-end" } as const;
const REFRESH_OVER = { position: "absolute", top: 0, bottom: 0, right: 0, flexDirection: "row", alignItems: "center" } as const;
const WARNING_GLYPH = { width: 18, height: 18 } as const;
const SPINNER_BOX = { width: TAB_ROW.closeSlot, height: TAB_ROW.closeSlot, alignItems: "center", justifyContent: "center" } as const;
const SPINNER_PIVOT = { transform: [{ translateX: REFRESH_ARROW_RING_OFFSET.x }, { translateY: REFRESH_ARROW_RING_OFFSET.y }] };
const SPINNER_GLYPH = { width: 14, height: 14, transform: [{ translateX: -REFRESH_ARROW_RING_OFFSET.x }, { translateY: -REFRESH_ARROW_RING_OFFSET.y }] };
const SPINNER_GLYPH_UNSHIFTED = { width: 14, height: 14 } as const;

export const LiveFolderBlock = memo(function LiveFolderBlock({ folderId, windowId }: { folderId: string; windowId: string }) {
  const tokens = useSidebarTokens();
  const folder = useLive((s) => s.folders[folderId]);
  const items = useLive((s) => s.items[folderId] ?? EMPTY);
  const showAll = useLive((s) => s.showAll);
  const folded = useDragFolded(entryKey("live", folderId));
  const collapsed = folded || !!folder?.collapsed;
  const rows = useMemo(() => (folder ? folderRows(folder, items, showAll) : []), [folder, items, showAll]);
  const itemIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const hiddenList = useLive((s) => s.hidden[folderId] ?? EMPTY);
  const repoHiddenList = useLive((s) => s.repoHidden[folderId] ?? EMPTY);
  const hiddenIds = useMemo(() => new Set([...hiddenList, ...repoHiddenList].map((i) => i.id)), [hiddenList, repoHiddenList]);
  const profileId = usePageProfileId();
  const strays = useLiveStrays(windowId, profileId, folderId, itemIds, hiddenIds);
  const { keep, showsExtra } = useLiveFolderKeep(windowId, profileId, folderId, collapsed, rows, strays, itemIds, hiddenIds);
  const completed = useCompletedShown(folderId).length > 0;
  const fold = useFold(collapsed);
  const foldedHeight = () => GROUP_BORDER * 2 + layout.rowHeight + (keep.length ? keep.length * layout.rowHeight + PAD : 0);
  const { wrapper, handle, headerRef } = useDragItem(entryKey("live", folderId), { kind: "live", tabIds: NONE, section: "pinnedGroups", liveFolderId: folderId, collapsed: !!folder?.collapsed, foldedHeight });
  const box = useGroupHover(windowId, `livefolder|${folderId}`);
  const boxOpacity = useHoverFade(box.hovered || groupBoxAtRest(folder?.color));
  if (!folder) return null;
  const { fill, stroke } = groupSurface(folder.color, tokens);

  const entries: FoldEntry[] = rows.length
    ? rows.map((row) => ({ key: row.key, node: <FolderRowView row={row} folderId={folderId} windowId={windowId} /> }))
    : [{ key: "note", node: <FolderNote folderId={folderId} windowId={windowId} /> }];
  for (const id of strays) entries.push({ key: `stray:${id}`, node: <TabRow tabId={id} /> });
  if (completed) entries.push({ key: "completed", node: <CompletedFooter folderId={folderId} windowId={windowId} /> });

  return (
    <Animated.View ref={wrapper.ref} style={wrapper.style}>
      <View {...box.hoverProps} style={BOX_ROOM}>
        <Animated.View
          pointerEvents="none"
          style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, ...clippedContinuousCorners(GROUP_RADIUS), backgroundColor: fill, borderWidth: GROUP_BORDER, borderColor: stroke, opacity: boxOpacity }}
        />
        <View ref={headerRef} {...handle} style={HEADER_ROOM}>
          <FolderHeader folderId={folderId} windowId={windowId} collapsed={collapsed} showsExtra={showsExtra} />
        </View>
        <Fold fold={fold} collapsed={collapsed} entries={entries} keep={keep} padBottom={PAD} />
      </View>
    </Animated.View>
  );
});

function FolderRowView({ row, folderId, windowId }: { row: FolderRow; folderId: string; windowId: string }) {
  switch (row.kind) {
    case "header":
      return <SectionTitle title={row.title} />;
    case "more":
      return <MoreRow folderId={folderId} section={row.section} count={row.count} />;
    case "stack":
      return <StackRow folderId={folderId} windowId={windowId} stack={row} />;
    case "item":
      return <LiveItemRow folderId={folderId} item={row.item} windowId={windowId} />;
  }
}

function FolderNote({ folderId, windowId }: { folderId: string; windowId: string }) {
  const status = useLive((s) => s.status[folderId]);
  const kind = useLive((s) => s.folders[folderId]?.kind);
  const hidden = useLive((s) => s.hidden[folderId]?.length ?? 0);
  if (!status || status.state === "initializing" || (status.state === "updating" && !status.lastFetch)) return <NoteRow text="Loading…" spinner />;
  if (status.error) return <NoteRow text={errorText(status.error.kind, status.error.source)} onPress={() => fixLiveFolderError(windowId, status.error)} icon="exclamationmark.triangle.fill" />;
  if (hidden) return <NoteRow text={`${hidden} hidden until you refresh`} onPress={() => void manualRefresh(folderId)} />;
  return <NoteRow text={kind === "pullRequests" ? "No open pull requests" : "No recent documents"} />;
}

function FolderHeader({ folderId, windowId, collapsed, showsExtra }: { folderId: string; windowId: string; collapsed: boolean; showsExtra: boolean }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const colors = useLiveColors();
  const folder = useLive((s) => s.folders[folderId]);
  const count = useLive((s) => s.items[folderId]?.length ?? 0);
  const unread = useLive((s) => (s.unread[folderId]?.length ?? 0) > 0);
  const status = useLive((s) => s.status[folderId]);
  const { hovered, hoverProps } = useHover();
  const updating = status?.state === "updating" || status?.state === "initializing";
  const refreshShown = hovered && !updating;
  const refreshOpacity = useHoverFade(refreshShown);
  const [restOpacity] = useState(() => Animated.subtract(1, refreshOpacity));
  const squish = useSquish("row");
  if (!folder) return null;

  return (
    <View ref={(v) => registerRow(windowId, `livefolder|${folderId}`, v)} {...hoverProps}>
      <ContextMenuArea
        onContextMenu={() => {
          dismissHover();
          void openLiveFolderMenu(windowId, folderId);
        }}
      >
        <Pressable
          onPressIn={squish.onPressIn}
          onPressOut={squish.onPressOut}
          onPress={() => {
            dismissHover();
            if (!showsExtra) return updateFolder(folderId, { collapsed: !collapsed });
            noteLiveFolderHeaderHide();
            hideShownTabs(folderId, windowId);
          }}
        >
          {() => (
            <Squish scale={squish.scale}>
            <SidebarRowSurface fill={ink.clear} cornerRadius={GROUP_INNER_RADIUS}>
              <LiveFolderIcon folder={folder} open={!collapsed} />
              <FolderHeaderTitle label={folder.name} color={tokens.groupTitle} />
              <View style={REFRESH_SLOT}>
                {updating ? (
                  <RefreshButton spinning tooltip={statusText(folderId)} onPress={() => void manualRefresh(folderId)} />
                ) : collapsed || status?.error ? (
                  <Animated.View style={{ flexDirection: "row", alignItems: "center", marginRight: space.xxs, gap: space.xs, opacity: restOpacity }}>
                    {collapsed && unread ? <Dot size={7} color={theme.accent} /> : null}
                    {collapsed ? <Badge text={count} size="m" /> : null}
                    {status?.error ? (
                      <Pressable accessibilityRole="button" accessibilityLabel={errorText(status.error.kind, status.error.source)} accessibilityHint="Resolves the warning" onAccessibilityTap={() => fixLiveFolderError(windowId, status.error)} onPress={() => fixLiveFolderError(windowId, status.error)}>
                        <Symbol name="exclamationmark.triangle.fill" size={10} color={colors.pending} style={WARNING_GLYPH} />
                      </Pressable>
                    ) : null}
                  </Animated.View>
                ) : null}
                {updating ? null : (
                  <Animated.View pointerEvents={refreshShown ? "auto" : "none"} style={[REFRESH_OVER, { opacity: refreshOpacity }]}>
                    <RefreshButton spinning={false} tooltip={statusText(folderId)} onPress={() => void manualRefresh(folderId)} />
                  </Animated.View>
                )}
              </View>
            </SidebarRowSurface>
            </Squish>
          )}
        </Pressable>
      </ContextMenuArea>
    </View>
  );
}

function RefreshButton({ spinning, tooltip, onPress }: { spinning: boolean; tooltip: string; onPress(): void }) {
  const theme = useTheme();
  if (!spinning) return <Button variant="icon" icon="arrow.clockwise" size="s" weight="semibold" onPress={onPress} tooltip={tooltip} />;
  const drawsOwnArrow = iconName("arrow.clockwise") === "arrow.clockwise";
  return (
    <View tooltip={tooltip} style={SPINNER_BOX}>
      <View style={drawsOwnArrow ? SPINNER_PIVOT : undefined}>
        <RefreshSpinner>
          <Symbol name="arrow.clockwise" size={10} weight="semibold" color={theme.textSecondary} style={drawsOwnArrow ? SPINNER_GLYPH : SPINNER_GLYPH_UNSHIFTED} />
        </RefreshSpinner>
      </View>
    </View>
  );
}
