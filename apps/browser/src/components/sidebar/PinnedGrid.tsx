import { memo, useMemo } from "react";
import { Animated, View } from "react-native";
import { radius, Symbol } from "../ui";
import { GlassGroup } from "../ui/Glass";
import { layout, useTheme } from "../ui/theme";
import { useSidebarField } from "../../state/sidebar/chrome";
import { useAddressBarInSidebar, useToolbarLightsCenter } from "../../state/windows/layout";
import { firstRowTopOf, listTopGap } from "./geometry";
import { useIsActiveTab, useSettings, useTab, useWindowId } from "../../state/browser/hooks";
import { useIsSelected } from "../../state/pins/hooks";
import { NextMeetingBadge } from "../live/NextMeetingBadge";
import { TileStatus } from "./TileStatus";
import { refreshShownTile } from "../../state/sidebar/actions";
import { cellKey, tailKey } from "./dragModel";
import { useDragController, useDragging, useDragItem, useDropPins, useFolderTarget, usePinnedCount, usePinSlots } from "./DragProvider";
import { FolderTile } from "./FolderTile";
import { useRowHover } from "./hoverController";
import { pinLayout, TILE_GAP } from "./pinZone";
import { registerRow } from "../../state/sidebar/sidebarUi";
import { FolderDropRing, TileFace, useSlotPosition } from "./TileFace";
import { folderIdOfCell } from "../../state/pins/tileFolders";
import { useSidebarTokens } from "./tokens";
import { TabPressArea } from "./TabPressArea";
import { entryKey } from "../../state/sidebar/entryKey";

export const PinnedGrid = memo(function PinnedGrid({ tabs, innerWidth, flush = false }: { tabs: string[]; innerWidth: number; flush?: boolean }) {
  const controller = useDragController();
  const count = usePinnedCount(tabs);
  const balanced = useSettings((st) => st.balancedTopApps);
  const square = useSettings((st) => st.squareTopApps);
  const { columns, width, height, gridHeight, pitch } = pinLayout(count, innerWidth, layout.pinnedHeight, balanced, square);
  const slots = usePinSlots(tabs);
  const tail = useDragItem(tailKey("tiles"), { kind: "tail", tabIds: [], section: "tiles" });
  const dragging = useDragging();
  const addressBar = useSidebarField() === "top";
  const topGap = listTopGap(addressBar);
  if (!tabs.length) return dragging && !addressBar && tail.gap ? <Animated.View style={{ height: tail.gap }} /> : null;
  return (
    <View
      ref={(v) => {
        controller?.regions.set("tiles", v);
      }}
      style={{ marginTop: flush ? 0 : topGap }}
    >
      <GlassGroup style={{ height: gridHeight }}>
        {tabs.map((cell, i) => {
          const x = (slots[i]! % columns) * (width + TILE_GAP);
          const y = Math.floor(slots[i]! / columns) * pitch;
          const folderId = folderIdOfCell(cell);
          return folderId ? (
            <FolderTile key={cellKey(cell)} folderId={folderId} width={width} height={height} sliding={dragging} x={x} y={y} />
          ) : (
            <PinnedTile key={cellKey(cell)} tabId={cell} width={width} height={height} sliding={dragging} x={x} y={y} />
          );
        })}
      </GlassGroup>
      <Animated.View ref={tail.wrapper.ref} style={{ position: "absolute", right: 0, bottom: 0, width: 0, height: 0 }} />
    </View>
  );
});

export function PinFieldZone({ top, height }: { top: number; height: number }) {
  const tokens = useSidebarTokens();
  const theme = useTheme();
  const controller = useDragController();
  const active = useDropPins();
  return (
    <View
      ref={(v) => {
        controller?.regions.set("tiles", v);
      }}
      onLayout={() => void controller?.tilesLaidOut()}
      pointerEvents="none"
      style={{
        position: "absolute",
        left: layout.sidebarInset,
        right: layout.sidebarInset,
        top,
        height,
        borderRadius: radius.chrome,
        borderWidth: active ? 1.5 : 1,
        borderStyle: "dashed",
        borderColor: active ? tokens.dropMark : tokens.dragBorder,
        backgroundColor: tokens.dragSilhouette,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <PinGlyph color={active ? tokens.dropMark : theme.textSecondary} />
    </View>
  );
}

const EMPTY_CELLS: string[] = [];

export function PinSlotZone({ top = 0, innerWidth }: { top?: number; innerWidth: number }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const controller = useDragController();
  const active = useDropPins();
  const gap = controller?.items.get(tailKey("tiles"))?.gap;
  const balanced = useSettings((st) => st.balancedTopApps);
  const square = useSettings((st) => st.squareTopApps);
  const count = usePinnedCount(EMPTY_CELLS);
  const { width, height, pitch } = pinLayout(count, innerWidth, layout.pinnedHeight, balanced, square);
  const opacity = gap ? gap.interpolate({ inputRange: [0, pitch], outputRange: [0, 1], extrapolate: "clamp" }) : active ? 1 : 0;
  const firstRowTop = firstRowTopOf(useAddressBarInSidebar(), useToolbarLightsCenter()[1], false);
  return (
    <>
      <View
        ref={(v) => {
          controller?.regions.set("tiles", v);
        }}
        onLayout={() => void controller?.tilesLaidOut()}
        pointerEvents="none"
        style={{
          position: "absolute",
          left: layout.sidebarInset,
          right: layout.sidebarInset,
          top: 0,
          height: top + (active ? firstRowTop + height : firstRowTop - layout.rowGap),
        }}
      />
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: layout.sidebarInset,
          width: square ? width : innerWidth,
          top: top + firstRowTop,
          height,
          opacity,
          borderRadius: radius.pinned,
          borderWidth: 1.5,
          borderStyle: "dashed",
          borderColor: tokens.dropMark,
          backgroundColor: theme.dropZoneFill,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <PinGlyph color={tokens.dropMark} />
      </Animated.View>
    </>
  );
}

function PinGlyph({ color }: { color: string }) {
  return <Symbol name="pin" size={13} color={color} style={{ width: 16, height: 16 }} />;
}

const PinnedTile = memo(function PinnedTile({ tabId, width, height, sliding, x, y }: { tabId: string; width: number; height: number; sliding: boolean; x: number; y: number }) {
  const windowId = useWindowId();
  const tab = useTab(tabId);
  const active = useIsActiveTab(tabId);
  const selected = useIsSelected(windowId, tabId);
  const { hovered, hoverProps } = useRowHover(windowId, { kind: "tab", id: tabId });
  const { wrapper, handle, dragging } = useDragItem(entryKey("tab", tabId), { kind: "tile", tabIds: [tabId], section: "tiles" });
  const target = useFolderTarget(entryKey("tab", tabId));
  const position = useSlotPosition(x, y, width, sliding, dragging);
  const overlays = useMemo(
    () => (
      <>
        <NextMeetingBadge tabId={tabId} />
        <TileStatus tabId={tabId} />
      </>
    ),
    [tabId],
  );
  if (!tab) return null;

  return (
    <Animated.View ref={wrapper.ref} style={[{ position: "absolute", ...position.getLayout() }, wrapper.style]} {...handle}>
      <FolderDropRing on={target} />
      <View
        ref={(v) => registerRow(windowId, tabId, v)}
        {...hoverProps}
      >
        <TabPressArea windowId={windowId} tab={tab} selected={selected} onDoubleClick={(wasShown) => refreshShownTile(windowId, tabId, wasShown)}>
          {({ pressed }) => (
            <TileFace tabId={tabId} width={width} height={height} active={active} selected={selected} hovered={hovered} pressed={pressed} />
          )}
        </TabPressArea>
        {overlays}
      </View>
    </Animated.View>
  );
});
