import { markOpenTabsSynced } from "./openTabCloses";
import { addLinkedProfile, linkedProfileId, remoteProfileRecord, sharedDataChain } from "./profileLinks";
import { markDeviceRemoved, markRemoved } from "./profileRemoval";
import { queueSend, sendTargetsIn } from "./sentTabs";
import { themeChosenHere } from "./syncThemes";
import type { DataType, SendTarget, SyncDoc } from "./syncDoc";

export type EditSteps = {
  doc: () => SyncDoc;
  refused: () => boolean;
  locked: () => boolean;
  save: () => void;
  changed: () => void;
  schedule: (delay: number) => void;
  afterEditMs: number;
};

export function syncEdits({ doc, refused, locked, save, changed, schedule, afterEditMs }: EditSteps) {
  const changedBy = (done: boolean) => done && (changed(), true);

  function adoptProfileTheme(profileId: string) {
    if (refused() || !themeChosenHere(doc().profiles[profileId])) return;
    save();
    if (doc().enabled) schedule(afterEditMs);
  }

  function setTypeSynced(type: DataType, enabled: boolean) {
    if (refused()) return;
    doc().types = { ...doc().types, [type]: enabled };
    changed();
  }

  function setProfileSynced(profileId: string, enabled: boolean) {
    const link = doc().profiles[profileId];
    if (!link || refused()) return;
    const { retire: _retire, ...kept } = link;
    doc().profiles[profileId] = enabled ? { ...kept, enabled } : { ...link, enabled, retire: true };
    changed();
  }

  function setOpenTabsSynced(profileId: string, on: boolean) {
    if (refused()) return;
    markOpenTabsSynced(doc(), profileId, on);
    changed();
  }

  const sendTargets = (profileId: string): SendTarget[] => (locked() || refused() ? [] : sendTargetsIn(doc(), profileId));

  function sendTab(tabId: string, deviceId: string): boolean {
    if (locked() || refused() || !queueSend(doc(), tabId, deviceId)) return false;
    save();
    schedule(0);
    return true;
  }

  function addRemoteProfile(syncId: string): string | null {
    const current = doc();
    if (refused() || !remoteProfileRecord(current, syncId) || linkedProfileId(current, syncId)) return null;
    const { adds, sharesWith, waitingFor } = sharedDataChain(current, syncId);
    if (waitingFor) return null;
    let shareWith = sharesWith;
    for (const add of adds.reverse()) shareWith = addLinkedProfile(current, add, remoteProfileRecord(current, add)!, shareWith);
    changed();
    return shareWith;
  }

  const removeRemoteProfile = (syncId: string): boolean => !refused() && changedBy(markRemoved(doc(), syncId));
  const removeSyncedDevice = (id: string): boolean => !refused() && changedBy(markDeviceRemoved(doc(), id));

  return { adoptProfileTheme, setTypeSynced, setProfileSynced, setOpenTabsSynced, sendTargets, sendTab, addRemoteProfile, removeRemoteProfile, removeSyncedDevice };
}
