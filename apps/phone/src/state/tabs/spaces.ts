import type { Design } from "../../lib/design.ts";
import type { BrowserTab } from "./tabModels.ts";

export type TabSpaces = { current: string | null; defaultId: string | null; known: readonly string[] };

export const UNSYNCED: TabSpaces = { current: null, defaultId: null, known: [] };

export type SpaceProfile = { syncId: string; isDefault: boolean };

export function tabSpacesFor(design: Design, syncEnabled: boolean, profiles: readonly SpaceProfile[], current: string | null): TabSpaces {
  if (design === "original" || !syncEnabled || !profiles.length) return UNSYNCED;
  const fallback = profiles.find((profile) => profile.isDefault) ?? profiles[0]!;
  return { current, defaultId: fallback.syncId, known: profiles.map((profile) => profile.syncId) };
}

export const isSplit = (spaces: TabSpaces) => spaces.current !== null && spaces.known.includes(spaces.current);

export const spaceOf = (spaces: TabSpaces, profileSyncId: string | null): string | null =>
  profileSyncId !== null && spaces.known.includes(profileSyncId) ? profileSyncId : spaces.defaultId;

export const belongsToSpace = (spaces: TabSpaces, profileSyncId: string | null) => !isSplit(spaces) || spaceOf(spaces, profileSyncId) === spaces.current;

export function tabsInSpace<T extends Pick<BrowserTab, "profileSyncId">>(tabs: readonly T[], spaces: TabSpaces): readonly T[] {
  return isSplit(spaces) ? tabs.filter((tab) => belongsToSpace(spaces, tab.profileSyncId)) : tabs;
}

export function spaceToShow(spaces: TabSpaces, tab: Pick<BrowserTab, "profileSyncId" | "isPrivate"> | null | undefined): string | null {
  if (!tab || tab.isPrivate || !isSplit(spaces)) return null;
  const space = spaceOf(spaces, tab.profileSyncId);
  return space !== spaces.current ? space : null;
}

export const sameSpaces = (a: TabSpaces, b: TabSpaces) =>
  a === b || (a.current === b.current && a.defaultId === b.defaultId && a.known.length === b.known.length && a.known.every((id, i) => id === b.known[i]));

export function moveTargets<T extends { syncId: string }>(spaces: TabSpaces, profiles: readonly T[], tab: Pick<BrowserTab, "isPrivate">): T[] {
  if (tab.isPrivate || !isSplit(spaces)) return [];
  return profiles.filter((profile) => profile.syncId !== spaces.current);
}
