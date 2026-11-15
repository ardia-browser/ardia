import { memo, useRef } from "react";
import { Animated, Pressable, View } from "react-native";
import { ContextMenuArea, space, Symbol } from "../ui";
import { layout, useTheme } from "../ui/theme";
import { usePageProfileId, useTab, useWindowId, useWindowProfileId } from "../../state/browser/hooks";
import { useShownFolderTab, useTileFolderMembers } from "../../state/pins/hooks";
import { useDragItem, useFolderTarget } from "./DragProvider";
import { dismissHover } from "../../state/sidebar/hover";
import { useRowHover } from "./hoverController";
import { registerRow } from "../../state/sidebar/sidebarUi";
import { TabIcon } from "./TabIcon";
import { FolderDropRing, RestingTile, TileFace, useSlotPosition } from "./TileFace";
import { closedByPress, openTileFolderMenu, toggleFolderPanel, useFolderPanel } from "../../state/sidebar/tileFolderUi";
import { entryKey } from "../../state/sidebar/entryKey";
import { TILE_STATUS } from "./tokens";

const MOSAICS = {
  tile: { cell: 9, gap: space.xxs, pad: space.xs },
  strip: { cell: 7, gap: space.xxs, pad: space.xxs },
};
const ROW_CELL = 14;
const ROW_MAX = 4;

export const FolderTile = memo(function FolderTile({ folderId, width, sliding, x, y }: { folderId: string; width: number; sliding: boolean; x: number; y: number }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const members = useTileFolderMembers(windowId, folderId);
  const onScreen = usePageProfileId() === useWindowProfileId();
  const shown = useShownFolderTab(windowId, folderId);
  const open = useFolderPanel((u) => u.open?.windowId === windowId && u.open.folderId === folderId);
  const { hovered, hoverProps } = useRowHover(windowId, { kind: "folder", id: folderId });
  const { wrapper, handle, dragging } = useDragItem(entryKey("tileFolder", folderId), { kind: "tile", tabIds: members, section: "tiles", folderId });
  const target = useFolderTarget(entryKey("tileFolder", folderId));
  const position = useSlotPosition(x, y, width, sliding, dragging);
  const pressedAt = useRef<number | undefined>(undefined);
  if (!members.length) return null;
  const glyph = (
    <View pointerEvents="none" style={{ position: "absolute", bottom: TILE_STATUS.inset.y, right: TILE_STATUS.inset.x }}>
      <Symbol name="folder" size={TILE_STATUS.speaker} color={theme.textSecondary} style={TILE_STATUS.box} />
    </View>
  );

  return (
    <Animated.View ref={wrapper.ref} style={[{ position: "absolute", ...position.getLayout() }, wrapper.style]} {...handle}>
      <FolderDropRing on={target} />
      <View ref={onScreen ? (v) => registerRow(windowId, folderId, v) : undefined} {...hoverProps}>
        <ContextMenuArea onContextMenu={() => void openTileFolderMenu(windowId, folderId)}>
          <Pressable
            onPressIn={(e) => void (pressedAt.current = e.nativeEvent.timestamp)}
            onPress={() => {
              dismissHover();
              if (!closedByPress(folderId, pressedAt.current)) void toggleFolderPanel(windowId, folderId);
            }}
          >
            {({ pressed }) =>
              shown ? (
                <TileFace tabId={shown} width={width} active selected={false} hovered={hovered} pressed={pressed} badge={glyph} />
              ) : (
                <RestingTile width={width} selected={open} hovered={hovered} pressed={pressed}>
                  <FolderMosaic tabIds={members} width={width} />
                </RestingTile>
              )
            }
          </Pressable>
        </ContextMenuArea>
      </View>
    </Animated.View>
  );
});

export function FolderMosaic({ tabIds, scale = "tile", width }: { tabIds: string[]; scale?: keyof typeof MOSAICS; width?: number }) {
  if (width) {
    const shown = tabIds.slice(0, ROW_MAX);
    const rows = shown.length > 2 ? [shown.slice(0, 2), shown.slice(2)] : [shown];
    return (
      <View style={{ width, height: layout.pinnedHeight, justifyContent: "space-evenly" }}>
        {rows.map((row) => (
          <View key={row[0]} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-evenly" }}>
            {row.map((id) => (
              <MosaicIcon key={id} tabId={id} cell={ROW_CELL} />
            ))}
          </View>
        ))}
      </View>
    );
  }
  const { cell, gap, pad } = MOSAICS[scale];
  const side = pad * 2 + cell * 2 + gap;
  return (
    <View
      style={{
        width: side,
        height: side,
        padding: pad,
        flexDirection: "row",
        flexWrap: "wrap",
        alignContent: "center",
        justifyContent: "center",
        gap,
      }}
    >
      {tabIds.slice(0, 4).map((id) => (
        <MosaicIcon key={id} tabId={id} cell={cell} />
      ))}
    </View>
  );
}

function MosaicIcon({ tabId, cell }: { tabId: string; cell: number }) {
  const tab = useTab(tabId);
  if (!tab) return <View style={{ width: cell, height: cell }} />;
  return (
    <View style={{ width: cell, height: cell, alignItems: "center", justifyContent: "center" }}>
      <TabIcon tabId={tabId} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} size={cell} />
    </View>
  );
}
