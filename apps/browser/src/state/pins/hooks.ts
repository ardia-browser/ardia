import { useContext } from "react";
import { useShallow } from "zustand/react/shallow";
import { useBrowser } from "../browser/store";
import { useTabState } from "../tabs/tabStateWatch";
import { activeTabId } from "../browser/model";
import { usePageSpaceId } from "../browser/hooks";
import { folderIn, folderLabel, folderMembers, tileFolderOf } from "./tileFolders";

export function useTileFolderMembers(windowId: string, folderId: string) {
  const spaceId = usePageSpaceId();
  return useBrowser(useShallow((s) => folderMembers(s, windowId, folderId, spaceId)));
}

export function useTileFolderLabel(windowId: string, folderId: string) {
  const spaceId = usePageSpaceId();
  return useBrowser((s) => folderLabel(folderIn(s, windowId, folderId, spaceId)));
}

export function useShownFolderTab(windowId: string, folderId: string) {
  const spaceId = usePageSpaceId();
  return useBrowser((s) => {
    const id = activeTabId(s, windowId, spaceId);
    return id && tileFolderOf(s.tabs[id])?.id === folderId ? id : null;
  });
}

export const useIsSelected = (windowId: string, tabId: string) => useTabState(tabId, (s) => (s.selection[windowId] ?? []).includes(tabId));

export const useSelectionInGroup = (windowId: string, groupId: string) =>
  useBrowser((s) => {
    const selection = s.selection[windowId];
    return !!selection?.length && !!s.groups[groupId]?.tabIds.some((id) => selection.includes(id));
  });
