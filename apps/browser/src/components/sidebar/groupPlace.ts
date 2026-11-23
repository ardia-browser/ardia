import type { BrowserState } from "../../state/browser/store";
import { entryKey } from "../../state/sidebar/entryKey";
import { headGap } from "../../state/sidebar/geometry";
import { layout } from "../ui/theme";
import { GROUP_BORDER } from "./geometry";
import { offsets, type Height } from "./listOffsets";
import { seenSliding, type ListViewport } from "./listViewport";

export type Section = { list: string[]; base: number };
type GroupPlaces = { sections: Section[]; membersOf: (s: BrowserState, groupId: string) => string[]; membersTop: (members: string[]) => number; height: Height };

export function groupMembersTop(s: BrowserState, groupId: string, places: GroupPlaces, depth = 0): number | null {
  const key = entryKey("group", groupId);
  for (const section of places.sections) {
    const at = section.list.includes(key) ? offsets(s, section.list, places.height).at.get(key) : undefined;
    if (at !== undefined) return section.base + at + places.membersTop(places.membersOf(s, groupId));
  }
  const parentId = s.groups[groupId]?.parentId;
  if (!parentId || depth > 8) return null;
  const parentTop = groupMembersTop(s, parentId, places, depth + 1);
  if (parentTop === null) return null;
  const siblings = places.membersOf(s, parentId);
  const at = offsets(s, siblings, places.height).at.get(key);
  return at === undefined ? null : parentTop + at + places.membersTop(places.membersOf(s, groupId));
}

type PlaceInputs = { entries: string[]; viewport: ListViewport | null; above: number; pinned: (() => Section | null) | null };

export const groupSeen = (read: () => PlaceInputs, height: Height, membersOf: GroupPlaces["membersOf"]) => (groupId: string, y: number, h: number, before: BrowserState) => {
  const { entries, viewport, above, pinned } = read();
  const band = viewport?.band() ?? null;
  if (!band) return true;
  const pinnedSection = pinned?.();
  const sections = pinnedSection ? [{ list: entries, base: above }, pinnedSection] : [{ list: entries, base: above }];
  const top = groupMembersTop(before, groupId, { sections, membersOf, membersTop: (m) => GROUP_BORDER + layout.rowHeight + headGap(m[0]), height });
  return top === null || seenSliding(top + y, h, 0, band);
};
