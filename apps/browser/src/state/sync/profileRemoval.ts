import { visible, type HLC, type ScopeState } from "../../platform/sync";
import { isFields, isStringList } from "../../lib/decode";
import { PROFILE, PROFILE_OPEN_TABS, PROFILE_THEME, PROFILE_TOP_APPS, SHARE, recordId, shareRecord } from "./records";
import { themeAngleKey } from "./profileAdapters";
import { linkedProfileId, remoteProfileRecord } from "./profileLinks";
import { APP_SCOPE, type ProfileRemoval, type SyncDoc } from "./syncDoc";
import { freezeDeviceRemovals, settleDeviceRemovals } from "./deviceRemoval";

export { markDeviceRemoved, takeReturnedDeviceRemovals, takeSyncedDeviceRemovals } from "./deviceRemoval";

let removals = 0;
let returned = 0;

const recordKeys = (syncId: string) => [...[PROFILE, SHARE, PROFILE_THEME, PROFILE_TOP_APPS, PROFILE_OPEN_TABS].map((prefix) => `${prefix}${syncId}`), themeAngleKey(syncId)];

const liveKeys = (app: ScopeState | undefined, syncId: string): Record<string, HLC> =>
  Object.fromEntries(recordKeys(syncId).flatMap((key) => (app?.records[key] && app.records[key].v !== null ? [[key, app.records[key].h]] : [])));

const isRemoval = (value: unknown): value is ProfileRemoval => isFields(value) && isFields(value.keys) && Object.values(value.keys).every((h) => typeof h === "string");

function removalTargets(doc: SyncDoc): Record<string, ProfileRemoval> {
  const saved = doc.removing;
  const entries = isStringList(saved)
    ? saved.flatMap((syncId) => {
        const keys = liveKeys(doc.scopes[APP_SCOPE], syncId);
        return Object.keys(keys).length ? [[syncId, { keys }] as const] : [];
      })
    : isFields(saved)
      ? Object.entries(saved).filter((entry): entry is [string, ProfileRemoval] => isRemoval(entry[1]))
      : [];
  return Object.fromEntries(entries.filter(([syncId]) => !linkedProfileId(doc, syncId)));
}

export function freezeRemovals(doc: SyncDoc): boolean {
  const devices = freezeDeviceRemovals(doc);
  if (!isStringList(doc.removing) || !doc.scopes[APP_SCOPE]?.joined) return devices;
  const targets = removalTargets(doc);
  if (Object.keys(targets).length) doc.removing = targets;
  else delete doc.removing;
  return true;
}

export const removedRecordKeys = (doc: SyncDoc): ReadonlySet<string> => {
  const app = doc.scopes[APP_SCOPE];
  return new Set(Object.values(removalTargets(doc)).flatMap(({ keys }) => Object.entries(keys).filter(([key, h]) => app?.records[key]?.h === h).map(([key]) => key)));
};

export const beingRemoved = (doc: SyncDoc, syncId: string) => syncId in removalTargets(doc);

export function sharesItsData(doc: SyncDoc, syncId: string): boolean {
  const app = doc.scopes[APP_SCOPE];
  if (!app) return false;
  return [...visible(app, SHARE)].some(([key, value]) => {
    const sharer = recordId(SHARE, key);
    return sharer !== syncId && shareRecord(value)?.o === syncId && !!remoteProfileRecord(doc, sharer) && !beingRemoved(doc, sharer);
  });
}

export function markRemoved(doc: SyncDoc, syncId: string): boolean {
  if (!remoteProfileRecord(doc, syncId) || linkedProfileId(doc, syncId) || beingRemoved(doc, syncId) || sharesItsData(doc, syncId)) return false;
  doc.removing = { ...removalTargets(doc), [syncId]: { keys: liveKeys(doc.scopes[APP_SCOPE], syncId) } };
  removals++;
  return true;
}

function settleRemoval(app: ScopeState, removal: ProfileRemoval): ProfileRemoval | null {
  let back = !!removal.returned;
  const keys = Object.entries(removal.keys).filter(([key, h]) => {
    const record = app.records[key];
    if (record?.h === h) return true;
    back ||= !!record && record.v !== null;
    return false;
  });
  if (keys.length) return { keys: Object.fromEntries(keys), ...(back ? { returned: true } : {}) };
  if (back) returned++;
  return null;
}

export function settleRemovals(doc: SyncDoc, app: ScopeState) {
  if (!app.joined) return;
  settleDeviceRemovals(doc, app);
  const left = Object.entries(removalTargets(doc)).flatMap(([syncId, removal]) => {
    const settled = settleRemoval(app, removal);
    return settled ? [[syncId, settled] as const] : [];
  });
  if (left.length) doc.removing = Object.fromEntries(left);
  else delete doc.removing;
}

export function takeSyncedProfileRemovals() {
  const taken = removals;
  removals = 0;
  return taken;
}

export function takeReturnedProfileRemovals() {
  const taken = returned;
  returned = 0;
  return taken;
}
