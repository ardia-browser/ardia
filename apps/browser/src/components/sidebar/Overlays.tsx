import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useWindowId } from "../../state/browser/hooks";
import { startSidebarEffects } from "../../state/sidebar/effects";
import { MeetingAlert } from "../live/MeetingAlert";
import { HoverCard } from "./HoverCard";
import { IconPicker } from "./IconPicker";
import { TileLetters } from "./TileLetters";
import { ProfileIconPicker } from "../profiles/ProfileIconPicker";
import { SearchTabs } from "./SearchTabs";
import { TabSwitcher } from "./TabSwitcher";
import { useSidebarWidth } from "../../state/sidebar/hooks";
import { sameSize, useSettled, type Size } from "../ui/useSettled";
import { useSidebarUi } from "../../state/sidebar/sidebarUi";
import { useMeetingAlert } from "../../state/live/alerts";
import { onWindowRootSize } from "../../state/windows/rootSize";

export function SidebarOverlays({ windowWidth }: { windowWidth: number }) {
  const windowId = useWindowId();
  const sidebarWidth = useSidebarWidth(windowId);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const settleSize = useSettled((next: Size) => setSize((prev) => (sameSize(prev, next) ? prev : next)));
  useEffect(startSidebarEffects, []);
  useEffect(() => onWindowRootSize(windowId, settleSize), [windowId]);
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <HoverCard windowId={windowId} width={size.width} height={size.height} />
      <SidebarPopups windowId={windowId} windowWidth={windowWidth} windowHeight={size.height} sidebarWidth={sidebarWidth} />
    </View>
  );
}

const ICON_PICKER = 1;
const SEARCH_TABS = 2;
const SWITCHER = 4;
const TILE_LETTERS = 8;

function SidebarPopups({ windowId, windowWidth, windowHeight, sidebarWidth }: { windowId: string; windowWidth: number; windowHeight: number; sidebarWidth: number }) {
  const open = useSidebarUi((u) => (u.iconPicker?.windowId === windowId ? ICON_PICKER : 0) | (u.searchTabs === windowId ? SEARCH_TABS : 0) | (u.switcher?.windowId === windowId ? SWITCHER : 0) | (u.tileLetters?.windowId === windowId ? TILE_LETTERS : 0));
  const alert = useMeetingAlert((s) => !!s.event);
  return (
    <>
      {alert ? <MeetingAlert windowId={windowId} windowWidth={windowWidth} /> : null}
      {open & ICON_PICKER ? <IconPicker windowId={windowId} sidebarWidth={sidebarWidth} /> : null}
      {open & TILE_LETTERS ? <TileLetters windowId={windowId} /> : null}
      <ProfileIconPicker windowId={windowId} />
      {open & SEARCH_TABS ? <SearchTabs windowId={windowId} windowWidth={windowWidth} /> : null}
      {open & SWITCHER ? <TabSwitcher windowId={windowId} windowWidth={windowWidth} windowHeight={windowHeight} /> : null}
    </>
  );
}
