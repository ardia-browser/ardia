import { confirm } from "../app/system";
import { removeRemoteProfile } from "./engine";
import type { RemoteProfile } from "./syncDoc";

type RemovalAsk = { windowId?: string; ask?: typeof confirm; mayRemove?: () => boolean; remove?: (syncId: string) => boolean | Promise<boolean> };

export async function confirmRemoveRemoteProfile(profile: Pick<RemoteProfile, "syncId" | "name">, { windowId, ask = confirm, mayRemove = () => true, remove = removeRemoteProfile }: RemovalAsk = {}): Promise<{ confirmed: boolean; removed: boolean }> {
  const { confirmed } = await ask({
    title: `Remove “${profile.name}” from Sync?`,
    message: "It leaves this list on all your devices. A device that still has this profile keeps it, and it comes back here.",
    confirmTitle: "Remove",
    destructive: true,
    windowId,
  });
  return { confirmed, removed: confirmed && mayRemove() && (await remove(profile.syncId)) };
}
