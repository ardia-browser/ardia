import { addSyncedProfile } from "./profileLinks";
import { markDeviceRemoved, markRemoved } from "./profileRemoval";
import { markOpenTabsSynced } from "./openTabCloses";
import type { DataType, SyncDoc } from "./syncDoc";

export function syncDocEdits(current: () => SyncDoc, changed: () => void) {
  return {
    setTypeSynced: (type: DataType, enabled: boolean): void => void ((current().types = { ...current().types, [type]: enabled }), changed()),
    setProfileSynced(profileId: string, enabled: boolean) {
      const doc = current();
      const link = doc.profiles[profileId];
      if (!link) return;
      const { retire: _retire, ...kept } = link;
      doc.profiles[profileId] = enabled ? { ...kept, enabled } : { ...link, enabled, retire: true };
      changed();
    },
    setOpenTabsSynced: (profileId: string, on: boolean): void => void (markOpenTabsSynced(current(), profileId, on), changed()),
    addRemoteProfile(syncId: string): string | null {
      const added = addSyncedProfile(current(), syncId);
      if (added !== undefined) changed();
      return added ?? null;
    },
    removeRemoteProfile: (syncId: string): boolean => markRemoved(current(), syncId) && (changed(), true),
    removeSyncedDevice: (id: string): boolean => markDeviceRemoved(current(), id) && (changed(), true),
  };
}
