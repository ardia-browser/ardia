import { useSettings } from "../../state/browser/hooks";
import { liveFolderIcon } from "../../state/live/sources";
import type { LiveFolder } from "../../state/live/types";
import { FolderOrIcon } from "./AnimatedFolder";
import { TabIcon } from "./TabIcon";

export function LiveFolderIcon({ folder, open }: { folder: LiveFolder; open: boolean }) {
  const serviceIcon = useSettings((s) => s.liveFolderIcon === "service");
  if (!serviceIcon) return <FolderOrIcon icon={folder.icon} open={open} color={folder.color} />;
  const { site, icon } = liveFolderIcon(folder);
  return <TabIcon url={site} icon={icon} />;
}
