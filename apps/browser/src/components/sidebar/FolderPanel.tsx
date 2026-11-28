import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, View } from "react-native";
import { layout, useTheme } from "../ui/theme";
import { useIsActiveTab, useTab } from "../../state/browser/hooks";
import { plural, tabTitle } from "../../state/browser/model";
import { useTileFolderLabel, useTileFolderMembers } from "../../state/pins/hooks";
import { SLIDE } from "../tabstrip/tokens";
import { useGated } from "../ui/motion";
import { ContextMenuArea, HoverCard as HoverPanel, HoverFill, OutsidePressArea, radius, space, useHover } from "../ui";
import { SectionLabel } from "./SectionLabel";
import { Squish, useSquish } from "../ui/Squish";
import { SidebarListRow, SidebarRowLabel } from "./SidebarRow";
import { TAB_ROW } from "./tokens";
import { clickTab } from "../../state/sidebar/actions";
import { useDragController, useDragItem, useFolderAway } from "./DragProvider";
import { openTabMenu } from "../../state/sidebar/menus";
import { TabIcon } from "./TabIcon";
import { closeFolderPanel, closeFolderPanelOnPress, closeFolderPanelWhenWindowMoves, openTileFolderMenu, useFolderPanel } from "../../state/sidebar/tileFolderUi";
import { tailKey } from "./dragModel";
import { useStruckTitle } from "../../state/sidebar/rowState";
import { watchSidebarControlsRow } from "../../state/windows/layout";
import { onWindowRootSize } from "../../state/windows/rootSize";
import { useSidebarScroller } from "./sidebarScroller";

const PANEL_GAP = space.s;

type Frame = { x: number; y: number; w: number; h: number };

export function FolderPanel({ windowId }: { windowId: string }) {
  const open = useFolderPanel((u) => (u.open?.windowId === windowId ? u.open : null));
  if (!open) return null;
  return <PanelBody key={open.folderId} windowId={windowId} folderId={open.folderId} anchor={open.anchor} />;
}

function PanelBody({ windowId, folderId, anchor }: { windowId: string; folderId: string; anchor: { x: number; y: number; width: number; height: number } }) {
  const controller = useDragController();
  const members = useTileFolderMembers(windowId, folderId);
  const label = useTileFolderLabel(windowId, folderId);
  const away = useFolderAway();
  const [root, setRoot] = useState<Frame | null>(null);
  const shown = useMemo(() => new Animated.Value(0), []);
  const opacity = useGated(!away, shown, 0);
  const tail = useDragItem(tailKey("folder"), { kind: "tail", tabIds: [], section: "folder" });
  const scroll = useRef<ScrollView>(null);
  const scroller = useSidebarScroller(scroll);

  useEffect(() => {
    const measureRoot = () => controller?.root?.measureInWindow((x, y, w, h) => setRoot({ x, y, w, h }));
    measureRoot();
    const stopRow = watchSidebarControlsRow(windowId, () => requestAnimationFrame(measureRoot));
    const stopSize = onWindowRootSize(windowId, () => requestAnimationFrame(measureRoot));
    return () => {
      stopRow();
      stopSize();
    };
  }, [controller, windowId]);
  useEffect(() => {
    if (!root) return;
    const spring = Animated.spring(shown, { toValue: 1, ...SLIDE });
    spring.start();
    return () => spring.stop();
  }, [root, shown]);
  useEffect(() => {
    if (!members.length) closeFolderPanel();
  }, [members.length]);
  useEffect(() => closeFolderPanelWhenWindowMoves(windowId), [windowId]);
  useEffect(
    () => () => {
      controller?.regions.delete("folder");
      controller?.folderScrolled(0);
    },
    [controller],
  );
  if (!root) return null;
  const top = anchor.y + anchor.height + PANEL_GAP - root.y;

  return (
    <Animated.View
      ref={(v: View | null) => {
        controller?.regions.set("folder", v);
      }}
      pointerEvents={away ? "none" : "box-none"}
      style={{
        position: "absolute",
        left: layout.sidebarInset,
        width: root.w - layout.sidebarInset * 2,
        top,
        opacity,
        transform: [{ scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }],
      }}
    >
      <OutsidePressArea onOutsidePress={closeFolderPanelOnPress}>
        <HoverPanel width={root.w - layout.sidebarInset * 2} pad="s" style={{ maxHeight: Math.max(0, root.h - top - PANEL_GAP) }}>
          <ContextMenuArea onContextMenu={() => void openTileFolderMenu(windowId, folderId)}>
            <SectionLabel title={`${label} · ${plural(members.length, "tab")}`} inset={space.s} top={space.xxs} bottom={space.s} />
          </ContextMenuArea>
          <ScrollView
            ref={scroll}
            {...scroller}
            scrollEventThrottle={16}
            onScroll={(e) => controller?.folderScrolled(e.nativeEvent.contentOffset.y)}
            contentContainerStyle={{ gap: layout.rowGap }}
          >
            {members.map((id) => (
              <MemberRow key={id} tabId={id} windowId={windowId} />
            ))}
            <Animated.View ref={tail.wrapper.ref} style={tail.wrapper.style} />
          </ScrollView>
        </HoverPanel>
      </OutsidePressArea>
    </Animated.View>
  );
}

function MemberRow({ tabId, windowId }: { tabId: string; windowId: string }) {
  const theme = useTheme();
  const tab = useTab(tabId);
  const active = useIsActiveTab(tabId);
  const struck = useStruckTitle(tabId);
  const { hovered, hoverProps } = useHover();
  const { wrapper, handle } = useDragItem(`fm:${tabId}`, { kind: "row", tabIds: [tabId], section: "folder" });
  const squish = useSquish("row");
  if (!tab) return null;
  return (
    <Animated.View ref={wrapper.ref} style={wrapper.style} {...handle}>
      <View {...hoverProps}>
        <ContextMenuArea onContextMenu={() => void openTabMenu(windowId, tab)}>
          <Pressable
            onPressIn={squish.onPressIn}
            onPressOut={squish.onPressOut}
            onPress={() => {
              closeFolderPanel();
              clickTab(windowId, tabId);
            }}
          >
            {({ pressed }) => (
              <Squish scale={squish.scale}>
              <SidebarListRow height={layout.rowHeight} padRight={TAB_ROW.contentLeft} fill={active && !pressed ? theme.pinnedSelectedFill : undefined}>
                <HoverFill shown={pressed || (hovered && !active)} instant={active} color={pressed ? theme.tabPressed : theme.tabHover} radius={radius.tile} />
                <TabIcon tabId={tabId} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} />
                <SidebarRowLabel text={tabTitle(tab)} color={active ? theme.textPrimary : theme.textTab} struck={struck} />
              </SidebarListRow>
              </Squish>
            )}
          </Pressable>
        </ContextMenuArea>
      </View>
    </Animated.View>
  );
}
