import { useState } from "react";
import { View } from "react-native";
import { usePluginSidebarViews, usePluginWindowEligible } from "../../state/plugins/hooks";
import { Box, layout, ListRow, Symbol, Text, useTheme } from "../ui";
import { PluginSurface } from "./PluginSurface";
import { SURFACE } from "./tokens";

type SidebarViewEntry = ReturnType<typeof usePluginSidebarViews>[number];

export function PluginSidebarViews({ windowId }: { windowId: string }) {
  const eligible = usePluginWindowEligible(windowId);
  const views = usePluginSidebarViews();
  if (!eligible || !views.length) return null;
  return (
    <Box gap="xs">
      {views.map((view) => (
        <SidebarViewSection key={`${view.plugin}:${view.id}`} view={view} windowId={windowId} />
      ))}
    </Box>
  );
}

function SidebarViewSection({ view, windowId }: { view: SidebarViewEntry; windowId: string }) {
  const theme = useTheme();
  const [open, setOpen] = useState(true);
  return (
    <View>
      <ListRow height={layout.rowHeight} onPress={() => setOpen((o) => !o)}>
        <Symbol name={open ? "chevron.down" : "chevron.right"} size={SURFACE.chevron} weight="semibold" color={theme.textTertiary} style={CHEVRON} />
        <Symbol name={view.icon || "puzzlepiece"} size={SURFACE.icon} color={theme.icon} style={ICON} />
        <Text numberOfLines={1} weight="medium" tone="textSecondary" style={FLEX}>
          {view.title}
        </Text>
      </ListRow>
      {open ? <PluginSurface plugin={view.plugin} surfaceId={view.id} kind="sidebar" windowId={windowId} /> : null}
    </View>
  );
}

const FLEX = { flex: 1 } as const;
const CHEVRON = { width: SURFACE.iconBox / 1.5, height: SURFACE.iconBox } as const;
const ICON = { width: SURFACE.iconBox, height: SURFACE.iconBox } as const;
