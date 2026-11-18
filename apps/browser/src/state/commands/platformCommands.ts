import { exportBookmarksFromWindow as exportBookmarks } from "../bookmarks/exportHtml";
import { useBrowser } from "../browser/store";
import { noteDownloadsPanelToggle } from "../telemetry/downloadsPanelCauses";
import { UNAVAILABLE_COMMANDS } from "./commandCatalog";

export const exportBookmarksFromWindow = async (windowId: string | null | undefined) => {
  if (!UNAVAILABLE_COMMANDS.has("exportBookmarks")) await exportBookmarks(windowId);
};

export function toggleDownloadsPanel(windowId: string, open: boolean) {
  noteDownloadsPanelToggle(open, "command");
  return useBrowser.getState().setDownloadsOpen(windowId, open);
}
