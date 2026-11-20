import { memo, useContext } from "react";
import { View } from "react-native";
import { FolderIcon, sidebarIconSize, TextScopeContext } from "../ui";
import { useTheme } from "../ui/theme";
import type { GroupColor } from "../../state/browser/types";
import { hasOwnGroupIcon } from "../../state/groups/groupIcons";
import { TabIcon } from "./TabIcon";
import { folderPalette } from "./tokens";

const FOLDER_SIDE = 16;
const FOLDER_MARK = 14;

export const AnimatedFolder = memo(function AnimatedFolder({ open, color, size }: { open: boolean; color?: GroupColor | null; size?: number }) {
  const theme = useTheme();
  const inSidebar = useContext(TextScopeContext) === "sidebar";
  const side = size ?? (inSidebar ? sidebarIconSize(FOLDER_SIDE) : FOLDER_SIDE);
  const mark = Math.round((side * FOLDER_MARK) / FOLDER_SIDE);
  return (
    <View style={{ width: side, height: side, alignItems: "center", justifyContent: "center" }}>
      <FolderIcon open={open} {...folderPalette(color, theme.dark, theme.powerUpColor ?? theme.accent)} style={{ width: mark, height: mark }} />
    </View>
  );
});

export function FolderOrIcon({ icon, open, color }: { icon: string | null | undefined; open: boolean; color?: GroupColor | null }) {
  return hasOwnGroupIcon(icon) ? <TabIcon url="" icon={icon} /> : <AnimatedFolder open={open} color={color} />;
}
