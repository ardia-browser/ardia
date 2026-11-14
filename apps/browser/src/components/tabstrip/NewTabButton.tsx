import { useEffect, useMemo, useRef } from "react";
import { Animated } from "react-native";
import type { ClickModifiers } from "../../lib/keys";
import { toggleNewTabBar } from "../../state/omnibox/newTabBar";
import { openOverflowMenu, openSidebarMenu } from "../../state/sidebar/menus";
import { openNewTabInSplit } from "../../state/splits/actions";
import { newTab } from "../../state/tabs/actions";
import { noteTabStripMenu } from "../../state/telemetry/usage";
import { Button, useHover, type IconPalette } from "../ui";
import { useTheme } from "../ui/theme";
import { perLook, radius } from "../ui/tokens";
import type { DragGeometry } from "./stripGroups";
import { registerSlot } from "./stripReorder";
import { GAP, ITEM_HEIGHT, ITEM_TOP, NEW_TAB_ICON, OVERFLOW_BUTTON, tabRadius } from "./tokens";

const NEW_TAB_HIT = perLook(() => ({ width: ITEM_HEIGHT, height: ITEM_HEIGHT, plateX: 0, plateY: 0, box: ITEM_HEIGHT, radius: tabRadius() }));
const OVERFLOW_HIT = perLook(() => ({ width: OVERFLOW_BUTTON.box, height: ITEM_HEIGHT, plateX: 0, plateY: (ITEM_HEIGHT - OVERFLOW_BUTTON.box) / 2, box: OVERFLOW_BUTTON.box, radius: radius.control }));
const OVERFLOW_STYLE = { marginLeft: GAP };

export function openTabStripMenu(windowId: string) {
  noteTabStripMenu("tabs");
  void openSidebarMenu(windowId);
}

export function NewTabButton({ windowId, geometry, pinned }: { windowId: string; geometry: DragGeometry; pinned: boolean }) {
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const palette = useMemo<IconPalette>(
    () => ({ icon: theme.textSecondary, iconDisabled: theme.iconDisabled, hover: theme.tabHover, pressed: theme.tabPressed }),
    [theme.textSecondary, theme.iconDisabled, theme.tabHover, theme.tabPressed],
  );
  const shift = useRef(new Animated.Value(0)).current;
  const latest = useRef(geometry);
  latest.current = geometry;
  const latestPinned = useRef(pinned);
  latestPinned.current = pinned;
  useEffect(() => registerSlot(() => latest.current, () => (latestPinned.current ? -1 : latest.current.slots.length), shift), []);
  const open = (modifiers: ClickModifiers) => {
    if (modifiers.altKey) openNewTabInSplit(windowId);
    else toggleNewTabBar(windowId) || newTab(windowId, { newTabCommand: true });
  };
  const openOverflow = () => {
    noteTabStripMenu("overflow");
    void openOverflowMenu(windowId);
  };
  return (
    <Animated.View {...hoverProps} style={{ marginTop: ITEM_TOP, flexDirection: "row", transform: [{ translateX: shift }] }}>
      <Button variant="icon" toolbar icon="plus" glyph={NEW_TAB_ICON} hit={NEW_TAB_HIT()} palette={palette} tooltip="New Tab (⌘T) — ⌥-click to open in Split View" onPress={open} onContextMenu={() => openTabStripMenu(windowId)} />
      <Button variant="icon" toolbar icon="chevron.down" glyph={OVERFLOW_BUTTON.glyph} weight="semibold" hit={OVERFLOW_HIT()} palette={palette} color={hovered ? theme.textSecondary : theme.textTertiary} style={OVERFLOW_STYLE} tooltip="Open and recently closed tabs" onPress={openOverflow} onContextMenu={() => openTabStripMenu(windowId)} />
    </Animated.View>
  );
}
