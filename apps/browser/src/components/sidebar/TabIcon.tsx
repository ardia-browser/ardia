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
  spaceId: space,
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
  spaceId?: string;
  direct?: boolean;
  marks?: number;
}) {
  useTheme();
  const inSidebar = useContext(TextScopeContext) === "sidebar";
  const size = compact ? (inSidebar ? sidebarIconSize(COMPACT_ICON) : COMPACT_ICON) : (givenSize ?? (inSidebar ? sidebarIconSize(ICON) : ICON));
  const sleeping = useIsSleeping(tabId ?? "");
  const marks = useIconMarks(tabId, givenMarks);
  const engine = tabId && size >= 14 ? markedEngine(marks) : null;
  const opacity = sleeping || marks & FADED ? SLEEPING_OPACITY : 1;
  const props = { url, favicon, icon, size, color, direct };
  if (!engine) return space || !tabId ? <Icon {...props} opacity={opacity} spaceId={space} /> : <TabSpaceIcon {...props} opacity={opacity} tabId={tabId} />;
  return (
    <View style={{ opacity }}>
      {space || !tabId ? <Icon {...props} spaceId={space} /> : <TabSpaceIcon {...props} tabId={tabId} />}
      <EngineMark mark={engine} size={size} />
    </View>
  );
});

function EngineMark({ mark, size }: { mark: PageEngine; size: number }) {
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
      <Symbol name={ENGINE_SYMBOLS[mark]} size={box - 3} weight="semibold" color={theme.icon} style={{ width: box, height: box }} />
    </View>
  );
}

function TabSpaceIcon({ tabId, ...props }: Omit<Parameters<typeof Icon>[0], "spaceId"> & { tabId: string }) {
  const spaceId = useTab(tabId, (t) => t?.spaceId);
  return <Icon {...props} spaceId={spaceId} />;
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
  spaceId,
  direct,
  opacity = 1,
}: {
  url: string;
  favicon?: string | null;
  icon?: string | null;
  size?: number;
  color?: string;
  spaceId?: string;
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
  return <Favicon url={url} favicon={favicon} size={size} spaceId={spaceId} direct={direct} opacity={opacity} />;
}
