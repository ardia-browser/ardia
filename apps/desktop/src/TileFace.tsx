import type { ReactNode } from "react";
import { View } from "react-native";
import { layout, useTheme } from "../../browser/src/components/ui/theme";
import { useTab } from "../../browser/src/state/browser/hooks";
import { TabBadges } from "../../browser/src/components/media/TabBadges";
import { TabIcon } from "../../browser/src/components/sidebar/TabIcon";
import { useSidebarTokens } from "../../browser/src/components/sidebar/tokens";
import { radius } from "../../browser/src/components/ui/tokens";

import { RestingTile as GlassRestingTile, TileFace as GlassTileFace } from "../../browser/src/components/sidebar/TileFace.tsx";
import { useGlass } from "../../browser/src/components/ui/Glass";
import { nativeGlassBehindWindow, useNativeGlass } from "./shellGlass";

export { FolderDropRing, useSlotPosition } from "../../browser/src/components/sidebar/TileFace.tsx";

function useNativeGlassTiles() {
  const available = useNativeGlass();
  const glass = useGlass();
  return glass && available && nativeGlassBehindWindow();
}

const DARK = {
  resting: "rgba(255,255,255,0.04)",
  hovered: "rgba(255,255,255,0.08)",
  active: "rgba(255,255,255,0.11)",
  pressed: "rgba(255,255,255,0.14)",
  stroke: "rgba(255,255,255,0.14)",
  activeStroke: "rgba(255,255,255,0.3)",
};

const LIGHT = {
  resting: "rgba(0,0,0,0.03)",
  hovered: "rgba(0,0,0,0.06)",
  active: "rgba(255,255,255,0.6)",
  pressed: "rgba(0,0,0,0.09)",
  stroke: "rgba(0,0,0,0.12)",
  activeStroke: "rgba(0,0,0,0.24)",
};

type FaceState = { width: number; active: boolean; selected: boolean; hovered: boolean; pressed: boolean };

export function TileFace({ tabId, badge, ...state }: FaceState & { tabId: string; badge?: ReactNode }) {
  const tab = useTab(tabId);
  const native = useNativeGlassTiles();
  if (native) return <GlassTileFace tabId={tabId} badge={badge} {...state} />;
  if (!tab) return null;
  return (
    <FlatTile {...state}>
      <View>
        <TabIcon tabId={tab.id} url={tab.url} favicon={tab.favicon} icon={tab.customIcon} />
        <TabBadges tabId={tabId} />
      </View>
      {badge}
    </FlatTile>
  );
}

export function RestingTile(props: Omit<FaceState, "active"> & { children: ReactNode }) {
  const native = useNativeGlassTiles();
  if (native) return <GlassRestingTile {...props} />;
  return <FlatTile {...props} active={false} />;
}

function FlatTile({ width, active, selected, hovered, pressed, children }: FaceState & { children: ReactNode }) {
  const theme = useTheme();
  const tokens = useSidebarTokens();
  const colors = theme.dark ? DARK : LIGHT;
  return (
    <View
      style={{
        width,
        height: layout.pinnedHeight,
        borderRadius: radius.pinned,
        borderWidth: active || selected ? 1 : 0.5,
        borderColor: selected ? tokens.dragBorder : active ? colors.activeStroke : colors.stroke,
        backgroundColor: pressed ? colors.pressed : active ? colors.active : hovered || selected ? colors.hovered : colors.resting,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </View>
  );
}
