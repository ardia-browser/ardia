import { createSharedFolder, identityOf, sharedFoldersAvailable, sharedLocation } from "../../platform/sharedFolders";
import { isIncognitoProfile, pinKeyOf } from "../browser/model";
import type { TabGroup } from "../browser/types";
import { groupLabel } from "../pins/tabGrouping";
import { addFolderGroup, fileUrlOf, stopSyncingGroup, syncedElsewhereText } from "../sharedFolders/actions";
import { syncFolderAfterNow, syncFolderNow } from "../sharedFolders/engine";
import { canShareGroup, sharedFolderOfGroup } from "../sharedFolders/removal";
import { bindFolderIfUnbound, boundFolders, folderRef, sharedFolderOf, useSharedFolders, type SharedFolder } from "../sharedFolders/store";
import type { BaseEntry } from "../sharedFolders/tree";
import { eligibleKind, ownEntry } from "./automationWindows";
import { addKey, bindingAt, canonicalFolder, discardFolder, isAbsolutePath, oneAtATime, readableFolder } from "./sharedFolderPaths";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { id, obj, text, WINDOW } from "./socketSchema";
import { expect, now, windowOrFocused } from "./socketTargets";
import { OpError } from "./workspaceTargets";

const linkCount = (base: BaseEntry[]): number => base.reduce((n, b) => n + (b.kind === "link" ? 1 : linkCount(b.children)), 0);

function groupsFor(profileId: string, key: string): TabGroup[] {
  const s = now();
  return Object.values(s.groups).filter((g) => g.profileId === profileId && g.pinned && !g.parentId && pinKeyOf(g) === key && eligibleKind(s, g.windowId) === "normal");
}

function row(profileId: string, key: string, folder: SharedFolder) {
  const groups = groupsFor(profileId, key);
  const sync = useSharedFolders.getState().sync[folderRef(profileId, key)];
  return {
    profile: profileId,
    key,
    groups: groups.map((g) => g.id),
    name: groups[0] ? groupLabel(now(), groups[0]) : (folder.path.split("/").filter(Boolean).at(-1) ?? ""),
    path: folder.path,
    url: fileUrlOf(folder.path),
    links: linkCount(folder.base),
    state: sync?.state ?? "waiting",
    waiting: sync?.waiting ?? 0,
    error: sync?.error ?? null,
    addedAt: folder.addedAt,
  };
}

function available() {
  if (!sharedFoldersAvailable()) throw new OpError("refused", "Shared folders aren't available in this Ardia.");
}

function groupOf(groupId: unknown): TabGroup {
  const s = now();
  const g = ownEntry(s.groups, groupId);
  if (!g || eligibleKind(s, g.windowId) !== "normal" || isIncognitoProfile(g.profileId)) throw new OpError("no_window", `There's no group ${String(groupId)} the ardia command can use.`);
  return g;
}

function list() {
  return boundFolders()
    .filter(({ profileId }) => !isIncognitoProfile(profileId) && !!now().profiles[profileId])
    .map(({ profileId, key, folder }) => row(profileId, key, folder));
}

function boundRow(profileId: string, key: string) {
  const folder = sharedFolderOf(profileId, key);
  if (!folder) throw new OpError("failed", "The folder stopped syncing before Ardia finished; nothing more was changed.");
  return row(profileId, key, folder);
}

function syncProblem(profileId: string, key: string): string | null {
  const sync = useSharedFolders.getState().sync[folderRef(profileId, key)];
  if (sync?.state === "synced" || sync?.state === "waiting") return null;
  if (sync?.error) return sync.error;
  return sync?.state === "missing" ? "Its folder can't be found any more. Stop syncing it, then share it again." : "Its links aren't in the folder yet. Try again in a moment.";
}

function sameShareable(g: TabGroup) {
  const s = now();
  const again = ownEntry(s.groups, g.id);
  return !!again && pinKeyOf(again) === pinKeyOf(g) && again.profileId === g.profileId && eligibleKind(s, again.windowId) === "normal" && canShareGroup(s, g.id);
}

async function newFolderFor(g: TabGroup, params: Record<string, unknown>, call: SocketCall) {
  if (params.parent !== undefined && !isAbsolutePath(params.parent)) throw new OpError("bad_request", "parent is an absolute folder path.");
  const location = sharedLocation();
  const given = params.parent as string | undefined;
  if (given === undefined && !location.iCloudAvailable) throw new OpError("refused", "iCloud Drive is off; pass parent, a folder that syncs some other way.");
  const checked = given === undefined ? null : await canonicalFolder(given, "parent");
  call.stillServing();
  if (!sameShareable(g)) throw new OpError("no_window", `Group ${g.id} changed before its folder was made; nothing was shared.`);
  const made = await createSharedFolder(checked?.path ?? location.path, groupLabel(now(), g) || "Shared Folder", checked && identityOf(checked));
  if (!call.serving() || !sameShareable(g)) {
    await discardFolder(made);
    call.stillServing();
    throw new OpError("no_window", `Group ${g.id} changed while its folder was being made; nothing was shared.`);
  }
  if (!bindFolderIfUnbound(g.profileId, pinKeyOf(g), made)) await discardFolder(made);
}

function share(params: Record<string, unknown>, call: SocketCall) {
  available();
  const g = groupOf(params.group);
  if (!canShareGroup(now(), g.id)) throw new OpError("bad_request", "Only a pinned folder at the top of the sidebar can be shared.");
  const key = pinKeyOf(g);
  return oneAtATime(folderRef(g.profileId, key), async () => {
    if (!sameShareable(g)) throw new OpError("no_window", `Group ${g.id} changed before it could be shared.`);
    if (!sharedFolderOf(g.profileId, key)) await newFolderFor(g, params, call);
    await syncFolderAfterNow(g.profileId, key, call.serving);
    call.stillServing();
    const shown = boundRow(g.profileId, key);
    const problem = syncProblem(g.profileId, key);
    if (problem) throw new OpError("failed", `The folder is shared at ${shown.path}, but it couldn't be synced yet: ${problem}`);
    return shown;
  });
}

async function add(params: Record<string, unknown>, call: SocketCall) {
  available();
  if (!isAbsolutePath(params.path)) throw new OpError("bad_request", "path is an absolute folder path.");
  const profileId = windowOrFocused(params.window).profileId;
  const found = await canonicalFolder(params.path, "path");
  call.stillServing();
  return oneAtATime(addKey(found), async () => {
    await readableFolder(found);
    call.stillServing();
    const known = await bindingAt(profileId, found);
    call.stillServing();
    if (known) {
      await syncFolderNow(profileId, known.key, call.serving);
      call.stillServing();
      return boundRow(profileId, known.key);
    }
    const elsewhere = syncedElsewhereText(found);
    if (elsewhere) throw new OpError("refused", elsewhere);
    const w = windowOrFocused(params.window);
    if (w.profileId !== profileId) throw new OpError("no_window", "The window changed profile before the folder was added; nothing was added.");
    const key = addFolderGroup(w.id, found);
    if (!key) throw new OpError("failed", "Another request added this folder first; nothing more was added.");
    await syncFolderNow(profileId, key, call.serving);
    call.stillServing();
    return boundRow(profileId, key);
  });
}

function sharedOf(groupId: unknown) {
  const g = groupOf(groupId);
  const shared = sharedFolderOfGroup(now(), g.id);
  if (!shared) throw new OpError("bad_request", `Group ${g.id} isn't a shared folder.`);
  return shared;
}

async function syncNow(params: Record<string, unknown>, call: SocketCall) {
  const { profileId, key } = sharedOf(params.group);
  await syncFolderNow(profileId, key, call.serving);
  call.stillServing();
  return boundRow(profileId, key);
}

async function stop(params: Record<string, unknown>) {
  const { profileId, key } = sharedOf(params.group);
  if (!(await stopSyncingGroup(params.group as string))) throw new OpError("failed", "Ardia stopped syncing the folder, but its last write didn't finish within 10 seconds, so it can't confirm nothing more was written. Check the folder.");
  expect(!sharedFolderOf(profileId, key), "the folder still syncs.");
  return { ok: true };
}

const GROUP = id("A pinned folder's group id from workspace or sharedFolders.list");
const ROW = "{profile, key, groups, name, path, url, links, state, waiting, error, addedAt}";

export const SHARED_FOLDER_METHODS: MethodSpec[] = [
  { name: "sharedFolders.list", mutates: false, description: "Sidebar folders backed by a folder on disk (shared through iCloud Drive or another synced folder), with their sync state", params: obj({}), result: `[${ROW}]`, run: list },
  {
    name: "sharedFolders.share",
    mutates: true,
    description: "Back a pinned folder with a folder on disk others can be invited to; its file URL is in the reply",
    params: obj({ group: GROUP, parent: text("The folder to make it in; iCloud Drive's Ardia folder when left out") }, ["group"]),
    result: ROW,
    run: share,
  },
  {
    name: "sharedFolders.add",
    mutates: true,
    description: "Add a folder on disk someone shared as a pinned folder in a window's profile",
    params: obj({ path: text("The folder's absolute path"), window: { ...WINDOW, description: "A window id from windows; the focused one when left out" } }, ["path"]),
    result: ROW,
    run: add,
  },
  { name: "sharedFolders.sync", mutates: true, description: "Sync a shared folder with its files now", params: obj({ group: GROUP }, ["group"]), result: ROW, run: syncNow },
  { name: "sharedFolders.stop", mutates: true, description: "Stop syncing a folder; the group and the files on disk stay", params: obj({ group: GROUP }, ["group"]), result: "{ok}", run: stop },
];
