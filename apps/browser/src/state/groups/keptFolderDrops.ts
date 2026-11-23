import type { BrowserState } from "../browser/store";
import { inPinnedContainer, viewTabIds } from "../browser/model";
import { dropping, type Drop } from "../drag/drops";
import { withSplitRows } from "../splits/splits";
import { consentToken } from "../telemetry/consentPeriod";
import { groupCloseAllowed, groupKeptOpen, noteKeptGroupDrop } from "./closeGuard";

export function keptFolderLeavingPinned(s: BrowserState, drop: Drop): string | null {
  if (drop.type !== "group" || !groupKeptOpen(drop.groupId)) return null;
  const after = dropping(s, [], drop);
  if (after === s) return null;
  const moved = after.groups[drop.groupId];
  return moved?.pinned && !moved.parentId ? null : drop.groupId;
}

export function dropTargetInPlace(s: BrowserState, drop: Drop): boolean {
  if (drop.type !== "group") return true;
  const { beforeId, parentId, pinned } = drop.placement;
  if (!beforeId) return true;
  const g = s.groups[drop.groupId];
  if (!g || !viewTabIds(s, g.windowId, g.profileId).includes(beforeId)) return false;
  return withSplitRows(s, [beforeId]).some((id) => (parentId ? s.groups[parentId]?.tabIds.includes(id) : inPinnedContainer(s, id) === pinned));
}

export async function dropOnceAllowed(windowId: string, groupId: string, move: () => boolean) {
  const consent = consentToken();
  noteKeptGroupDrop("asked", consent);
  if (!(await groupCloseAllowed(windowId, groupId))) return;
  if (move()) noteKeptGroupDrop("confirmed", consent);
}
