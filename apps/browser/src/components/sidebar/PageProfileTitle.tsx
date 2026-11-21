import { memo, useRef } from "react";
import { Pressable, View } from "react-native";
import { ContextMenuArea, HoverFill, radius, Text, useHover } from "../ui";
import { layout, profileNameColor, useTheme } from "../ui/theme";
import { useProfile, useWindowId } from "../../state/browser/hooks";
import { openProfileMenu } from "../../state/browser/actions";
import { useSidebarPart } from "../../state/sidebar/chrome";
import { usePageNamesItsProfile } from "../../state/sidebar/pageTitle";
import { notePageProfileTitleMenu } from "../../state/telemetry/usage";
import { openProfileItemMenu } from "../profiles/profileMenu";
import { TAB_ROW } from "./tokens";

export const PageProfileTitle = memo(function PageProfileTitle({ profileId }: { profileId: string }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const named = usePageNamesItsProfile(profileId);
  const profileShown = useSidebarPart("profile");
  const profile = useProfile(profileId, (p) => p);
  const { hovered, hoverProps } = useHover();
  const title = useRef<View>(null);
  if (!named || !profileShown || !profile) return null;

  return (
    <View {...hoverProps} ref={title} style={{ marginBottom: layout.rowGap }}>
      <ContextMenuArea onContextMenu={() => void openProfileItemMenu(profileId, "sidebar", windowId, title.current)}>
        <Pressable
          tooltip="Switch between profiles"
          onPress={() => {
            notePageProfileTitleMenu();
            void openProfileMenu(windowId);
          }}
        >
          {({ pressed }) => (
            <View style={{ height: layout.rowHeight, borderRadius: radius.chrome, flexDirection: "row", alignItems: "center", paddingHorizontal: TAB_ROW.contentLeft }}>
              <HoverFill shown={hovered || pressed} color={pressed ? theme.tabPressed : theme.tabHover} radius={radius.chrome} />
              <Text lines={1} weight="semibold" style={{ flexShrink: 1, color: profileNameColor(profile, theme.dark) }}>
                {profile.name}
              </Text>
            </View>
          )}
        </Pressable>
      </ContextMenuArea>
    </View>
  );
});
