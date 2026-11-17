import { liveFolderIcon } from "../../state/live/sources";
import type { LiveFolder } from "../../state/live/types";
import { TabIcon } from "./TabIcon";

export function LiveFolderIcon({ folder }: { folder: LiveFolder }) {
  const { site, icon } = liveFolderIcon(folder);
  return <TabIcon url={site} icon={icon} />;
}
