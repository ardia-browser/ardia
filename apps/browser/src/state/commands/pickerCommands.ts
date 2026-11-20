import { pickFiles, prompt } from "../../platform/dialogs";
import { useBrowser } from "../browser/store";
import { bookmarkProfileId, resolveWindowId } from "../browser/model";
import { openWindow } from "../browser/actions";

export async function addBookmarkToFolder(windowId: string, tabId: string, folder: string) {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab?.url) return;
  const profileId = bookmarkProfileId(s, s.windows[windowId]);
  let parentId = folder;
  if (folder === "new") {
    const title = await prompt({ title: "New Folder", placeholder: "Folder name", confirmTitle: "Create", windowId });
    if (!title) return;
    parentId = useBrowser.getState().addBookmarkFolder({ profileId, title });
  }
  useBrowser.getState().addBookmark({ profileId, url: tab.url, title: tab.title, favicon: tab.favicon, parentId });
}

export async function openFiles(windowId: string | null) {
  const urls = await pickFiles();
  if (!urls.length) return;
  const s = useBrowser.getState();
  const target = resolveWindowId(s, windowId);
  if (!target) return void openWindow({ url: urls[0] });
  let last: string | undefined;
  for (const url of urls) last = useBrowser.getState().newTab(target, { url });
  if (last) useBrowser.getState().activate(last);
}
