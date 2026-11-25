import { useShallow } from "zustand/react/shallow";
import { useBrowser } from "../browser/store";
import { useTabState } from "../tabs/tabStateWatch";
import { usePageProfileId } from "../browser/hooks";
import { folderIn, folderLabel, folderMembers, shownFolderTab } from "./tileFolders";

export function useTileFolderMembers(windowId: string, folderId: string) {
  const profileId = usePageProfileId();
  return useBrowser(useShallow((s) => folderMembers(s, windowId, folderId, profileId)));
}

export function useTileFolderLabel(windowId: string, folderId: string) {
  const profileId = usePageProfileId();
  return useBrowser((s) => folderLabel(folderIn(s, windowId, folderId, profileId)));
}

export function useShownFolderTab(windowId: string, folderId: string) {
  const profileId = usePageProfileId();
  return useBrowser((s) => shownFolderTab(s, windowId, profileId, folderId));
}

export const useIsSelected = (windowId: string, tabId: string) => useTabState(tabId, (s) => (s.selection[windowId] ?? []).includes(tabId));

export const useSelectionInGroup = (windowId: string, groupId: string) =>
  useBrowser((s) => {
    const selection = s.selection[windowId];
    return !!selection?.length && !!s.groups[groupId]?.tabIds.some((id) => selection.includes(id));
  });
