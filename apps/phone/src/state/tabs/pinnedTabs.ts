import type { BrowserTab } from "./tabModels.ts";

export type PinnedMatch = { tab: BrowserTab; how: "tied" | "movedOn" | "sameAddress" };

type Facts = Pick<BrowserTab, "id" | "url" | "profileSyncId" | "pinnedKey" | "lastActive">;

const newest = <T extends Facts>(tabs: readonly T[]): T | null => tabs.reduce<T | null>((best, tab) => (best && best.lastActive >= tab.lastActive ? best : tab), null);

export function tabForRemote<T extends Facts>(open: readonly T[], url: string, profileSyncId: string | null, pinnedKey: string | null): { tab: T; how: PinnedMatch["how"] } | null {
  const inProfile = open.filter((tab) => tab.profileSyncId === profileSyncId);
  if (pinnedKey) {
    const tied = newest(inProfile.filter((tab) => tab.pinnedKey === pinnedKey));
    if (tied) return { tab: tied, how: tied.url === url ? "tied" : "movedOn" };
  }
  const same = inProfile.find((tab) => tab.url === url && (!pinnedKey || !tab.pinnedKey));
  return same ? { tab: same, how: "sameAddress" } : null;
}
