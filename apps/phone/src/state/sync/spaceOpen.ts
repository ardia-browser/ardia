import { create } from "zustand";

export type SpaceOpen = { open: readonly string[]; expanded: readonly string[] };

const NOTHING_OPEN: SpaceOpen = { open: [], expanded: [] };

export const useSpaceOpen = create<Record<string, SpaceOpen>>()(() => ({}));

export const spaceOpenFor = (profileId: string): SpaceOpen => useSpaceOpen.getState()[profileId] ?? NOTHING_OPEN;

export const useSpaceOpenFor = (profileId: string): SpaceOpen => useSpaceOpen((all) => all[profileId] ?? NOTHING_OPEN);

export function toggleSpaceRow(profileId: string, key: string) {
  const now = spaceOpenFor(profileId);
  const open = now.open.includes(key) ? now.open.filter((open) => open !== key) : [...now.open, key];
  useSpaceOpen.setState({ [profileId]: { ...now, open } });
}

export function showAllDeviceTabs(profileId: string, deviceId: string) {
  const now = spaceOpenFor(profileId);
  if (now.expanded.includes(deviceId)) return;
  useSpaceOpen.setState({ [profileId]: { ...now, expanded: [...now.expanded, deviceId] } });
}
