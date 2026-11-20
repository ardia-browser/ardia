import { useEffect, useMemo, useState } from "react";
import { Animated, Pressable, View } from "react-native";
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

  useEffect(() => {
    const measureRoot = () => controller?.root?.measureInWindow((x, y, w, h) => setRoot({ x, y, w, h }));
    measureRoot();
    return watchSidebarControlsRow(windowId, () => requestAnimationFrame(measureRoot));
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
    },
    [controller],
  );
  if (!root) return null;

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
        top: anchor.y + anchor.height + PANEL_GAP - root.y,
        opacity,
        transform: [{ scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }],
      }}
    >
      <OutsidePressArea onOutsidePress={closeFolderPanelOnPress}>
        <HoverPanel width={root.w - layout.sidebarInset * 2} pad="s">
          <ContextMenuArea onContextMenu={() => void openTileFolderMenu(windowId, folderId)}>
            <SectionLabel title={`${label} · ${plural(members.length, "tab")}`} inset={space.s} top={space.xxs} bottom={space.s} />
          </ContextMenuArea>
          <View style={{ gap: layout.rowGap }}>
            {members.map((id) => (
              <MemberRow key={id} tabId={id} windowId={windowId} />
            ))}
            <Animated.View ref={tail.wrapper.ref} style={tail.wrapper.style} />
          </View>
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
