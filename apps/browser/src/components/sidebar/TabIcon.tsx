import { memo, useContext } from "react";
import { View } from "react-native";
import { useIsSleeping } from "../../state/tabs/tabLifecycle";
import { sidebarIconSize, Symbol, Text, TextScopeContext } from "../ui";
import { useTheme } from "../ui/theme";
import { sidebarTokens } from "./tokens";
import { useTab } from "../../state/browser/hooks";
import { ENGINE_NAMES, ENGINE_SYMBOLS, type PageEngine } from "../../state/engines/engines";
import { FADED, markedEngine, useIconMarks } from "../../state/sidebar/rowState";
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
  const sleeping = useIsSleeping(tabId ?? "");
  const marks = useIconMarks(tabId, givenMarks);
  return tabIconView({ tabId, url, favicon, icon, size: useIconSize(compact, givenSize), color, profile, direct, marks, sleeping });
});

export const RowTabIcon = memo(function RowTabIcon({
  tabId,
  url,
  favicon,
  icon,
  size: givenSize,
  compact = false,
  color,
  profileId: profile,
  direct,
  marks,
  sleeping,
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
  marks: number;
  sleeping: boolean;
}) {
  return tabIconView({ tabId, url, favicon, icon, size: useIconSize(compact, givenSize), color, profile, direct, marks, sleeping });
});

function useIconSize(compact: boolean, givenSize: number | undefined) {
  useTheme();
  const inSidebar = useContext(TextScopeContext) === "sidebar";
  return compact ? (inSidebar ? sidebarIconSize(COMPACT_ICON) : COMPACT_ICON) : (givenSize ?? (inSidebar ? sidebarIconSize(ICON) : ICON));
}

function tabIconView({
  tabId,
  url,
  favicon,
  icon,
  size,
  color,
  profile,
  direct,
  marks,
  sleeping,
}: {
  tabId?: string;
  url: string;
  favicon?: string | null;
  icon?: string | null;
  size: number;
  color?: string;
  profile?: string;
  direct?: boolean;
  marks: number;
  sleeping: boolean;
}) {
  const engine = tabId && size >= 14 ? markedEngine(marks) : null;
  const opacity = sleeping || marks & FADED ? SLEEPING_OPACITY : 1;
  const props = { url, favicon, icon, size, color, direct };
  if (!engine) return profile || !tabId ? <Icon {...props} opacity={opacity} profileId={profile} /> : <TabProfileIcon {...props} opacity={opacity} tabId={tabId} />;
  return (
    <View style={{ opacity }}>
      {profile || !tabId ? <Icon {...props} profileId={profile} /> : <TabProfileIcon {...props} tabId={tabId} />}
      <EngineMark mark={engine} size={size} />
    </View>
  );
}

export function EngineMark({ mark, size }: { mark: PageEngine; size: number }) {
  const theme = useTheme();
  const box = Math.round(size * 0.6);
  return (
    <View
      pointerEvents="none"
      accessibilityLabel={`Opens in ${ENGINE_NAMES[mark]}`}
      style={{
        position: "absolute",
        right: -box / 3,
        bottom: -box / 3,
        width: box,
        height: box,
        borderRadius: box / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: sidebarTokens(theme).engineMarkPlate,
      }}
    >
      <Symbol name={ENGINE_SYMBOLS[mark]} size={box - 3} weight="semibold" color={theme.icon} centresInk style={{ width: box, height: box }} />
    </View>
  );
}

function TabProfileIcon({ tabId, ...props }: Omit<Parameters<typeof Icon>[0], "profileId"> & { tabId: string }) {
  const profileId = useTab(tabId, (t) => t?.profileId);
  return <Icon {...props} profileId={profileId} />;
}

export const SLEEPING_OPACITY = 0.45;
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
  return <Favicon url={url} favicon={favicon} size={size} profileId={profileId} direct={direct} opacity={opacity} fallbackColor={color} />;
}
