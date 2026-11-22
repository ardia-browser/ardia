import { isIncognitoProfile, pinKeyOf } from "../browser/model";
import type { TabGroup } from "../browser/types";
import { groupLabel } from "../pins/tabGrouping";
import { fileUrlOf } from "../sharedFolders/actions";
import { boundFolders, folderRef, useSharedFolders, type SharedFolder } from "../sharedFolders/store";
import type { BaseEntry } from "../sharedFolders/tree";
import { eligibleKind } from "./automationWindows";
import type { MethodSpec } from "./socketCatalog";
import { obj } from "./socketSchema";
import { now } from "./socketTargets";
import { t } from "../../lib/uiLanguage";


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

function list() {
  return boundFolders()
    .filter(({ profileId }) => !isIncognitoProfile(profileId) && !!now().profiles[profileId])
    .map(({ profileId, key, folder }) => row(profileId, key, folder));
}

const ROW = t(`{profile, key, groups, name, path, url, links, state, waiting, error, addedAt}`);

export const SHARED_FOLDER_METHODS: MethodSpec[] = [
  { name: "sharedFolders.list", mutates: false, description: t(`Sidebar folders backed by a folder on disk (shared through iCloud Drive or another synced folder), with their sync state`), params: obj({}), result: `[${ROW}]`, run: list },
];
