import { useEffect, useMemo, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { layout, useTheme } from "../ui/theme";
import { useIsActiveTab, useTab } from "../../state/browser/hooks";
import { plural, tabTitle } from "../../state/browser/model";
import { useTileFolderLabel, useTileFolderMembers } from "../../state/pins/hooks";
import { useGated } from "../ui/motion";
import { ClosingView, ContextMenuArea, HoverCard as HoverPanel, HoverFill, OutsidePressArea, useLiveWhile, radius, space, useClosing, useHover, useLiveAction, usePopoverMotion, usePopoverMotionStyle, usePopoverPresenceOf } from "../ui";
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
  const { shown: open, closing, onClosed } = usePopoverPresenceOf(useFolderPanel((u) => (u.open?.windowId === windowId ? u.open : null)));
  if (!open) return null;
  return <PanelBody key={open.folderId} windowId={windowId} folderId={open.folderId} anchor={open.anchor} closing={closing} onClosed={onClosed} />;
}

type Anchor = { x: number; y: number; width: number; height: number };

function PanelBody({ windowId, folderId, anchor, closing, onClosed }: { windowId: string; folderId: string; anchor: Anchor; closing: boolean; onClosed: () => void }) {
  const controller = useDragController();
  const members = useTileFolderMembers(windowId, folderId);
  const label = useTileFolderLabel(windowId, folderId);
  const away = useFolderAway();
  const [root, setRoot] = useState<Frame | null>(null);
  const appear = usePopoverMotion(closing, onClosed, !!root);
  const originX = root ? anchor.x + anchor.width / 2 - root.x - layout.sidebarInset : 0;
  const origin = useMemo<[number, number, number]>(() => [originX, 0, 0], [originX]);
  const motion = usePopoverMotionStyle(appear, origin);
  const opacity = useGated(!away, appear, 0);
  const live = useLiveWhile(closing);
  const tail = useDragItem(tailKey("folder"), { kind: "tail", tabIds: [], section: "folder" });

  useEffect(() => {
    const measureRoot = () => controller?.root?.measureInWindow((x, y, w, h) => setRoot({ x, y, w, h }));
    measureRoot();
    return watchSidebarControlsRow(windowId, () => requestAnimationFrame(measureRoot));
  }, [controller, windowId]);
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
    <ClosingView
      closing={closing}
      ref={(v: View | null) => {
        if (closing) controller?.regions.delete("folder");
        else controller?.regions.set("folder", v);
      }}
      pointerEvents={away || closing ? "none" : "box-none"}
      style={{
        position: "absolute",
        left: layout.sidebarInset,
        width: root.w - layout.sidebarInset * 2,
        top: anchor.y + anchor.height + PANEL_GAP - root.y,
        ...motion,
        opacity,
      }}
    >
      <OutsidePressArea onOutsidePress={live(closeFolderPanelOnPress)}>
        <HoverPanel width={root.w - layout.sidebarInset * 2} pad="s">
          <ContextMenuArea onContextMenu={live(() => void openTileFolderMenu(windowId, folderId))}>
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
    </ClosingView>
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
  const closing = useClosing();
  const live = useLiveAction();
  if (!tab) return null;
  return (
    <Animated.View ref={wrapper.ref} style={wrapper.style} {...handle} onStartShouldSetResponder={live(handle.onStartShouldSetResponder)} onMoveShouldSetResponder={live(handle.onMoveShouldSetResponder)}>
      <View {...hoverProps}>
        <ContextMenuArea onContextMenu={live(() => void openTabMenu(windowId, tab))}>
          <Pressable
            disabled={closing}
            onPressIn={squish.onPressIn}
            onPressOut={squish.onPressOut}
            onPress={live(() => {
              closeFolderPanel();
              clickTab(windowId, tabId);
            })}
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
