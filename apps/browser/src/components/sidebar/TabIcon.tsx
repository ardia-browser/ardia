import { memo, useContext } from "react";
import { View } from "react-native";
import { useIsSleeping } from "../../state/tabs/tabLifecycle";
import { sidebarIconSize, Symbol, Text, TextScopeContext } from "../ui";
import { useTheme } from "../ui/theme";
import { sidebarTokens } from "./tokens";
import { useTab } from "../../state/browser/hooks";
import { FADED, useIconMarks } from "../../state/sidebar/rowState";
import { iconSymbol } from "../../lib/customIcon";
import { drawnIcon } from "../../state/pins/rowIcons";
import { Favicon } from "../favicon/Favicon";

export const TabIcon = memo(function TabIcon({
  tabId,
  url,
  favicon,
  icon,
  size: givenSize,
  compact = false,
  color,
  profileId: profile,
  direct,
  marks: givenMarks,
}: {
  tabId?: string;
  url: string;
  favicon?: string | null;
  icon?: string | null;
  size?: number;
  compact?: boolean;
  color?: string;
  profileId?: string;
  direct?: boolean;
  marks?: number;
}) {
  useTheme();
  const inSidebar = useContext(TextScopeContext) === "sidebar";
  const size = compact ? (inSidebar ? sidebarIconSize(COMPACT_ICON) : COMPACT_ICON) : (givenSize ?? (inSidebar ? sidebarIconSize(ICON) : ICON));
  const sleeping = useIsSleeping(tabId ?? "");
  const marks = useIconMarks(tabId, givenMarks);
  const opacity = sleeping || marks & FADED ? SLEEPING_OPACITY : 1;
  const props = { url, favicon, icon, size, color, direct };
  return profile || !tabId ? <Icon {...props} opacity={opacity} profileId={profile} /> : <TabProfileIcon {...props} opacity={opacity} tabId={tabId} />;
});

function TabProfileIcon({ tabId, ...props }: Omit<Parameters<typeof Icon>[0], "profileId"> & { tabId: string }) {
  const profileId = useTab(tabId, (t) => t?.profileId);
  return <Icon {...props} profileId={profileId} />;
}

const SLEEPING_OPACITY = 0.45;
const ICON = 16;
const COMPACT_ICON = 14;

function Icon({
  url,
  favicon,
  icon,
  size = 16,
  color,
  profileId,
  direct,
  opacity = 1,
}: {
  url: string;
  favicon?: string | null;
  icon?: string | null;
  size?: number;
  color?: string;
  profileId?: string;
  direct?: boolean;
  opacity?: number;
}) {
  const theme = useTheme();
  icon = drawnIcon(icon);
  const symbol = iconSymbol(icon);
  if (symbol) return <Symbol name={symbol} size={size - 3} weight="medium" color={color ?? theme.icon} style={{ width: size, height: size, opacity }} />;
  if (icon) {
    return (
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", opacity }}>
        <Text style={{ fontSize: size - 3, lineHeight: size }}>{icon}</Text>
      </View>
    );
  }
  return <Favicon url={url} favicon={favicon} size={size} profileId={profileId} direct={direct} opacity={opacity} />;
}
