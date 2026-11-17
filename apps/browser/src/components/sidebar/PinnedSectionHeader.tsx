import { memo } from "react";
import { Animated, Pressable, View } from "react-native";
import { useProfile } from "../../state/browser/hooks";
import { openSidebarMenu } from "../../state/sidebar/menus";
import { PINNED_FOLD_TITLES, togglePinnedFold } from "../../state/sidebar/pinnedFold";
import { ContextMenuArea, radius, Symbol, useHover } from "../ui";
import { layout, useTheme } from "../ui/theme";
import { SidebarRowLabel } from "./SidebarRow";
import { ROW_GLYPH, TAB_ROW } from "./tokens";

type HeaderProps = { windowId: string; profileId: string; collapsed: boolean; open: Animated.Value; top: number; bottom: number; dragRegion: (view: View | null) => void };

export const PinnedSectionHeader = memo(function PinnedSectionHeader({ windowId, profileId, collapsed, open, top, bottom, dragRegion }: HeaderProps) {
  const name = useProfile(profileId, (profile) => profile?.name ?? "");
  const theme = useTheme();
  const { hovered, hoverProps } = useHover();
  const label = collapsed ? PINNED_FOLD_TITLES.expand : PINNED_FOLD_TITLES.collapse;
  const rotate = open.interpolate({ inputRange: [0, 1], outputRange: ["-90deg", "0deg"] });
  const toggle = () => togglePinnedFold(profileId);
  return (
    <View {...hoverProps} ref={dragRegion} style={{ marginTop: top, marginBottom: bottom }}>
      <ContextMenuArea onContextMenu={() => void openSidebarMenu(windowId)}>
        <Pressable tooltip={label} accessibilityRole="button" accessibilityLabel={`${label}, ${name}`} accessibilityState={{ expanded: !collapsed }} onAccessibilityTap={toggle} onPress={toggle}>
          {({ pressed }) => (
            <View
              style={{
                height: layout.rowHeight,
                borderRadius: radius.chrome,
                flexDirection: "row",
                alignItems: "center",
                paddingLeft: TAB_ROW.contentLeft,
                paddingRight: TAB_ROW.trailing,
                backgroundColor: pressed ? theme.tabPressed : hovered ? theme.tabHover : undefined,
              }}
            >
              <Animated.View style={{ width: ROW_GLYPH.box, height: ROW_GLYPH.box, alignItems: "center", justifyContent: "center", transform: [{ rotate }] }}>
                <Symbol name="chevron.down" size={9} weight="semibold" color={theme.textTab} style={{ width: 10, height: 10 }} />
              </Animated.View>
              <SidebarRowLabel text={name} color={theme.textTab} weight="medium" />
            </View>
          )}
        </Pressable>
      </ContextMenuArea>
    </View>
  );
});
