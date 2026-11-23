import type { WindowChrome } from "../../lib/windowChrome";
import { useBrowser } from "../browser/store";
import { closeBookmarkDialog, useBookmarkDialog } from "../bookmarks/actions";
import { useUrlAnchors, watchSidebarControlsRow } from "../windows/layout";
import { dismissHoverIn } from "./hover";
import { setSidebarUi, sidebarUi } from "./sidebarUi";
import { closeFolderPanelIn } from "./tileFolderUi";

function closeWhatTheSidebarAnchors(windowId: string) {
  dismissHoverIn(windowId);
  closeFolderPanelIn(windowId);
  if (sidebarUi().iconPicker?.windowId === windowId) setSidebarUi({ iconPicker: null });
  if (useBookmarkDialog.getState().open?.windowId === windowId) closeBookmarkDialog();
  const s = useBrowser.getState();
  if (s.windowUi[windowId]?.panel.open && useUrlAnchors.getState()[windowId]?.sidebar) s.closePanel(windowId);
}

export const closeAnchoredWhenControlsRowChanges = (windowId: string, chrome?: WindowChrome): (() => void) =>
  watchSidebarControlsRow(windowId, () => closeWhatTheSidebarAnchors(windowId), chrome);
