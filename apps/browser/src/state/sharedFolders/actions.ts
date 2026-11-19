import { confirm, pickFolder } from "../../platform/dialogs";
import { sharePage } from "../../platform/share";
import { createSharedFolder, discardSharedFolder, identityOf, resolveSharedFolder, revealSharedFolder, sharedFoldersAvailable, sharedLocation, type ResolvedSharedFolder } from "../../platform/sharedFolders";
import { errorText } from "../../lib/errors";
import { addKey, bindingAt, boundWithIdentity, oneAtATime } from "./bindings";
import { useBrowser, type BrowserState } from "../browser/store";
import type { Tab } from "../browser/types";
import { isIncognitoProfile, makeTab, newId, pinKeyOf } from "../browser/model";
import { pinnedGroupMembers } from "../browser/structure";
import { insertAll, nestGroups, orderSections, syncGroupOrder } from "../groups/groups";
import { markPinned } from "../pins/pinChoices";
import { groupLabel } from "../pins/tabGrouping";
import { ASLEEP } from "../tabs/pageSession";
import { isRegularWindow } from "../windows/small";
import { measureRow } from "../sidebar/sidebarUi";
import { EMPTY_FOLDER_URL } from "./applyFolder";
import { stopSyncing, syncFolderAfterNow, syncFolderNow } from "./engine";
import { bindFolder, bindFolderIfUnbound, folderRef, reconnectFolder, sharedFolderOf, useSharedFolders, type SharedFolder } from "./store";
import { canShareGroup, sharedFolderOfGroup } from "./removal";
import { showToast } from "../app/toasts";

const store = () => useBrowser.getState();

export const fileUrlOf = (path: string) => `file://${path.split("/").map(encodeURIComponent).join("/")}/`;

async function chooseParent(windowId: string): Promise<string | null> {
  const location = sharedLocation();
  if (location.iCloudAvailable) return location.path;
  const { confirmed } = await confirm({
    title: "iCloud Drive Is Off",
    message:
      "Shared folders live in iCloud Drive, where the people you invite get your changes. Turn it on in System Settings › Apple Account › iCloud, or keep the folder in another folder that syncs, like one in Dropbox.",
    confirmTitle: "Choose Folder…",
    windowId,
  });
  return confirmed ? pickFolder(null, "Use Folder") : null;
}

export function withSharedGroup(s: BrowserState, windowId: string, name: string): [BrowserState, string] {
  const w = s.windows[windowId];
  if (!isRegularWindow(w)) return [s, ""];
  const profileId = w.profileId;
  const tab: Tab = { ...makeTab(windowId, profileId, EMPTY_FOLDER_URL, { title: "Empty Folder", customTitle: "Empty Folder" }), page: ASLEEP };
  const id = newId("g");
  const groups = nestGroups({
    ...s.groups,
    [id]: { id, windowId, profileId, name, icon: null, color: null, collapsed: false, pinned: true, tabIds: [tab.id], createdAt: Date.now() },
  });
  const tabs = { ...s.tabs, [tab.id]: tab };
  const pinnedArea = pinnedGroupMembers(s.groups);
  const ids = [...w.tabIds];
  insertAll(ids, w.tabIds.reduce((last, t, i) => (s.tabs[t]?.pin || pinnedArea.has(t) ? i + 1 : last), 0), [tab.id]);
  const window = { ...w, tabIds: orderSections(ids, tabs, groups) };
  const pinChoices = markPinned(s.pinChoices, profileId, { groups: [id], placed: [tab.id] });
  return [{ ...s, tabs, pinChoices, groups: syncGroupOrder(groups, window), windows: { ...s.windows, [windowId]: window } }, id];
}

export async function addSharedFolder(windowId: string) {
  const w = store().windows[windowId];
  if (!sharedFoldersAvailable() || !isRegularWindow(w) || isIncognitoProfile(w.profileId)) return;
  const location = sharedLocation();
  const start = location.iCloudAvailable ? location.path : await chooseParent(windowId);
  if (!start) return;
  const picked = await pickFolder(start, "Add Folder");
  if (!picked) return;
  const found = await resolveSharedFolder(picked).catch((error: unknown) => {
    showToast(windowId, "Couldn’t add this folder", errorText(error), { icon: "exclamationmark.icloud" });
    return null;
  });
  if (!found) return;
  const profileId = store().windows[windowId]?.profileId ?? w.profileId;
  return oneAtATime(addKey(found), async () => {
    const known = await bindingAt(profileId, found);
    if (known) {
      const g = Object.values(store().groups).find((x) => x.profileId === profileId && x.pinned && pinKeyOf(x) === known.key);
      showToast(windowId, `“${(g && groupLabel(store(), g)) || found.path.split("/").at(-1)}” is already in your sidebar`, undefined, { icon: "person.2" });
      return syncFolderNow(profileId, known.key);
    }
    if (store().windows[windowId]?.profileId !== profileId) return;
    const elsewhere = syncedElsewhereText(found);
    if (elsewhere) return showToast(windowId, "Couldn’t add this folder", elsewhere, { icon: "exclamationmark.icloud" });
    const key = addFolderGroup(windowId, found);
    if (key) await syncFolderNow(profileId, key);
  });
}

export function addFolderGroup(windowId: string, found: ResolvedSharedFolder): string | null {
  const w = store().windows[windowId];
  if (!isRegularWindow(w) || boundWithIdentity(found)) return null;
  const [next, groupId] = withSharedGroup(store(), windowId, found.path.split("/").filter(Boolean).at(-1) ?? "Shared Folder");
  if (!groupId) return null;
  useBrowser.setState(next);
  const key = pinKeyOf(store().groups[groupId]!);
  bindFolder(w.profileId, key, found.path, identityOf(found));
  return key;
}

export async function shareFolder(windowId: string, groupId: string) {
  const s = store();
  const g = s.groups[groupId];
  if (!g || !canShareGroup(s, groupId)) return;
  const key = pinKeyOf(g);
  try {
    let folder = sharedFolderOf(g.profileId, key);
    if (!folder) {
      const parent = await chooseParent(windowId);
      if (!parent) return;
      const made = await createSharedFolder(parent, groupLabel(s, g) || "Shared Folder");
      if (!bindFolderIfUnbound(g.profileId, key, made)) await discardSharedFolder(made).catch(() => false);
    }
    await syncFolderAfterNow(g.profileId, key);
    folder = sharedFolderOf(g.profileId, key);
    if (!folder) return;
    const state = useSharedFolders.getState().sync[folderRef(g.profileId, key)]?.state;
    if (state !== "synced" && state !== "waiting") {
      const why = useSharedFolders.getState().sync[folderRef(g.profileId, key)]?.error;
      const reason = why ?? (state === "missing" ? "Its folder can’t be found any more. Stop syncing it, then share it again." : "Its links aren’t in the folder yet. Try again in a moment.");
      return showToast(windowId, "Couldn’t share this folder yet", reason, { icon: "exclamationmark.icloud" });
    }
    const anchor = await measureRow(windowId, groupId);
    await sharePage(fileUrlOf(folder.path), groupLabel(store(), g) || null, windowId, anchor ? [anchor.x, anchor.y, anchor.width, anchor.height] : null);
  } catch (error) {
    showToast(windowId, "Couldn’t share this folder", error instanceof Error ? error.message : String(error), { icon: "exclamationmark.icloud" });
  }
}

export function revealGroupFolder(groupId: string) {
  const shared = sharedFolderOfGroup(store(), groupId);
  if (shared) void revealSharedFolder(shared.folder.path);
}

export function stopSyncingGroup(groupId: string): Promise<boolean> {
  const shared = sharedFolderOfGroup(store(), groupId);
  return shared ? stopSyncing(shared.profileId, shared.key) : Promise.resolve(true);
}

export function syncedElsewhereText(found: ResolvedSharedFolder): string | null {
  const bound = boundWithIdentity(found);
  if (!bound) return null;
  const s = store();
  const g = Object.values(s.groups).find((x) => x.profileId === bound.profileId && x.pinned && !x.parentId && pinKeyOf(x) === bound.key);
  const name = (g && groupLabel(s, g)) || bound.folder.path.split("/").at(-1) || "A folder";
  const profile = s.profiles[bound.profileId]?.name ?? "another profile";
  return `“${name}” in ${profile} already syncs this folder; a folder syncs with one profile at a time.`;
}

export async function reconnectSharedFolder(windowId: string, groupId: string) {
  const shared = sharedFolderOfGroup(store(), groupId);
  if (!shared || shared.folder.identity) return;
  const was: SharedFolder = shared.folder;
  const picked = await pickFolder(was.path.split("/").slice(0, -1).join("/") || null, "Reconnect");
  if (!picked) return;
  const found = await resolveSharedFolder(picked).catch((error: unknown) => {
    showToast(windowId, "Couldn’t reconnect this folder", errorText(error), { icon: "exclamationmark.icloud" });
    return null;
  });
  if (!found) return;
  return oneAtATime(addKey(found), async () => {
    const elsewhere = syncedElsewhereText(found);
    if (elsewhere) return showToast(windowId, "Couldn’t reconnect this folder", elsewhere, { icon: "exclamationmark.icloud" });
    if (reconnectFolder(shared.profileId, shared.key, was, found)) await syncFolderNow(shared.profileId, shared.key);
  });
}
