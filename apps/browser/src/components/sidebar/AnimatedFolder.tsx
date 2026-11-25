import { memo, useContext } from "react";
import { FolderIcon, sidebarIconSize, TextScopeContext } from "../ui";
import { useTheme } from "../ui/theme";
import type { GroupColor } from "../../state/browser/types";
import { useSettings } from "../../state/browser/hooks";
import { hasOwnGroupIcon } from "../../state/groups/groupIcons";
import { TabIcon } from "./TabIcon";
import { folderPalette } from "./tokens";

const FOLDER_SIDE = 16;

export const AnimatedFolder = memo(function AnimatedFolder({ open, color, size }: { open: boolean; color?: GroupColor | null; size?: number }) {
  const theme = useTheme();
  const folderStyle = useSettings((s) => s.folderStyle);
  const inSidebar = useContext(TextScopeContext) === "sidebar";
  const side = size ?? (inSidebar ? sidebarIconSize(FOLDER_SIDE) : FOLDER_SIDE);
  return <FolderIcon open={open} {...folderPalette(color, theme.dark, theme.powerUpColor ?? theme.accent, folderStyle, theme.windowTint)} style={{ width: side, height: side }} />;
});

export function FolderOrIcon({ icon, open, color }: { icon: string | null | undefined; open: boolean; color?: GroupColor | null }) {
  return hasOwnGroupIcon(icon) ? <TabIcon url="" icon={icon} /> : <AnimatedFolder open={open} color={color} />;
}
