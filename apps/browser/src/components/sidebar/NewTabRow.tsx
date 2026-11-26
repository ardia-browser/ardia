import { memo } from "react";
import { Animated, Pressable, View } from "react-native";
import { Button, concentric, ContextMenuArea, continuousCorners, drawnSymbol, HoverFill, iconButton, perLook, radius, sidebarPoints, useHover, withAlpha } from "../ui";
import { hex, layout, useTheme } from "../ui/theme";
import { useSettings } from "../../state/browser/hooks";
import { newTab } from "../../state/tabs/actions";
import { openNewTabInSplit } from "../../state/splits/actions";
import { splitViewAvailable } from "../../state/splits/splits";
import { openOverflowMenu, openSidebarMenu } from "../../state/sidebar/menus";
import { toggleNewTabBar } from "../../state/omnibox/newTabBar";
import { noteRowPressIn } from "../../state/sidebar/heldTabPress";
import { modifiersOf } from "../../lib/keys";
import { useShortcutHint, withShortcut } from "../../state/commands/commandShortcuts";
import { useClipped, useShift, type ClipSource } from "./EntryMotion";
import { ROW_GLYPH, TAB_ROW, useSidebarTokens } from "./tokens";
import { SidebarRowLabel } from "./SidebarRow";
import { useQuietRows } from "./rowLook";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";
import { Squish, useSquish } from "../ui/Squish";

const clippedRow = perLook(() => ({ marginTop: -layout.rowGap, paddingTop: layout.rowGap, overflow: "hidden" as const }));
const BUTTONS_ROOM = TAB_ROW.trailing + TAB_ROW.closeSlot + TAB_ROW.trailing;

export const NewTabRow = memo(function NewTabRow({ windowId, shift = null, clip = null }: { windowId: string; shift?: Animated.Value | null; clip?: ClipSource | null }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const showTabMenuButton = useSettings((s) => s.showTabMenuButton);
  const quiet = useQuietRows();
  const { hovered, hoverProps } = useHover();
  const newTabHint = useShortcutHint("newTab");
  const squish = useSquish("row");
  const pressMotion = usePressScaleMotion(!squish.scale, buttonMotion.iconPressScale);
  const iconScale = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : undefined;
  const [moved, movedRef] = useShift(shift);
  const [movedButtons, movedButtonsRef] = useShift(shift);
  const clipped = useClipped(clip);
  const quietInk = hex(withAlpha(theme.textTab, hovered ? tokens.quietText : tokens.quietFaintText));
  return (
    <View {...hoverProps} style={[{ flexDirection: "row", alignItems: "center" }, clipped ? clippedRow() : null]}>
      <ContextMenuArea style={{ flex: 1 }} onContextMenu={() => void openSidebarMenu(windowId)}>
        <Pressable
          tooltip={`${withShortcut("New Tab", newTabHint)} — ⌥-click to open in Split View`}
          onPressIn={() => {
            squish.onPressIn?.();
            pressMotion.onPressIn?.();
            noteRowPressIn(windowId);
          }}
          onPressOut={() => {
            squish.onPressOut?.();
            pressMotion.onPressOut?.();
          }}
          onPress={(e) => {
            if (modifiersOf(e).altKey && splitViewAvailable) openNewTabInSplit(windowId);
            else toggleNewTabBar(windowId) || newTab(windowId, { newTabCommand: true });
          }}
        >
          {({ pressed }) => (
            <Squish scale={squish.scale}>
            <View
              {...moved}
              ref={movedRef}
              style={[
                {
                  height: layout.rowHeight,
                  ...continuousCorners(radius.chrome),
                  flexDirection: "row",
                  alignItems: "center",
                  paddingLeft: TAB_ROW.contentLeft,
                  paddingRight: showTabMenuButton ? BUTTONS_ROOM : TAB_ROW.trailing * 2,
                },
                moved.style as object,
              ]}
            >
              <HoverFill shown={hovered || pressed} color={pressed ? (quiet ? tokens.quietPressed : theme.tabPressed) : quiet ? tokens.quietHover : theme.tabHover} radius={radius.chrome} />
              <Animated.View pointerEvents="none" style={iconScale}>
                {drawnSymbol({ name: "plus", size: quiet ? sidebarPoints(10) : ROW_GLYPH.plus, weight: "medium", color: quiet ? quietInk : tokens.newTabIcon, style: { width: ROW_GLYPH.box, height: ROW_GLYPH.box } })}
              </Animated.View>
              <SidebarRowLabel text="New Tab" color={quiet ? quietInk : tokens.newTabLabel} compact={quiet} />
            </View>
            </Squish>
          )}
        </Pressable>
      </ContextMenuArea>
      <View {...movedButtons} ref={movedButtonsRef} style={[{ position: "absolute", right: TAB_ROW.trailing, flexDirection: "row", alignItems: "center" }, movedButtons.style as object]}>
        {!showTabMenuButton || (quiet && !hovered) ? null : <Button variant="icon"
          icon="chevron.down"
          size="s"
          radius={concentric(radius.chrome, (layout.rowHeight - iconButton.s.box) / 2)}
          weight="semibold"
          color={hovered ? theme.textSecondary : theme.textTertiary}
          tooltip="Open and recently closed tabs"
          onPress={() => void openOverflowMenu(windowId)}
        />}
      </View>
    </View>
  );
});
