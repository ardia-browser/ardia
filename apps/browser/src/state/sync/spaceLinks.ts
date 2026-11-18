import { emptyScope, pullSettled, SyncNative, visible, type ScopeState } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { DEFAULT_SPACE_ID } from "../settings/settings";
import { legacyThemeOf, type SpaceRecord } from "./spaceAdapters";
import { APP_SCOPE, spaceScope, type SyncDoc } from "./syncDoc";
import { openTabsRecord, profileRecord, shareRecord, topAppsRecord } from "./records";
import { pairTheme } from "./syncThemes";
import { identityRecord, profileKey } from "./identityAdapters";
import { useLegacyTopApps } from "../pins/legacyTopApps";

export const remoteSpaceRecord = (doc: SyncDoc, syncId: string) => profileRecord(doc.scopes[APP_SCOPE]?.records[`prof:${syncId}`]?.v) ?? undefined;
export const linkedSpaceId = (doc: SyncDoc, syncId: string): string | null => Object.entries(doc.spaces).find(([id, link]) => link.syncId === syncId && !link.retire && useBrowser.getState().spaces[id])?.[0] ?? null;
export const linkedProfileId = (doc: SyncDoc, syncId: string): string | null => Object.entries(doc.profiles).find(([id, link]) => link.syncId === syncId && !link.retire && useBrowser.getState().profiles[id])?.[0] ?? null;
export const appReady = (app: ScopeState) => app.joined && pullSettled(app);

function ownerOf(app: ScopeState, syncId: string): { owner?: string; waitingFor?: string } {
  const path: string[] = [];
  let id = syncId;
  while (!path.includes(id)) {
    if (!profileRecord(app.records[`prof:${id}`]?.v)) return { waitingFor: id };
    path.push(id);
    const share = app.records[`share:${id}`]?.v;
    if (share == null) return { owner: id };
    const next = shareRecord(share)?.o;
    if (!next?.trim()) return { waitingFor: id };
    id = next;
  }
  return { owner: path.slice(path.indexOf(id)).sort()[0] };
}

export function sharedDataChain(doc: SyncDoc, syncId: string): { owner?: string; sharesWith: string | null; waitingFor?: string } {
  const app = doc.scopes[APP_SCOPE];
  if (!app || !appReady(app)) return { sharesWith: null, waitingFor: syncId };
  const resolved = ownerOf(app, syncId);
  return { ...resolved, sharesWith: resolved.owner ? linkedProfileId(doc, resolved.owner) : null };
}

export function spaceOwnerMatches(doc: SyncDoc, spaceId: string): boolean {
  const link = doc.spaces[spaceId];
  const space = useBrowser.getState().spaces[spaceId];
  const app = doc.scopes[APP_SCOPE];
  if (!link?.ownerSyncId || !space || !app || !pullSettled(app)) return false;
  return doc.profiles[space.profileId]?.syncId === link.ownerSyncId && ownerOf(app, link.syncId).owner === link.ownerSyncId;
}

export function dataOwnerMatches(doc: SyncDoc, profileId: string): boolean {
  const app = doc.scopes[APP_SCOPE];
  const { profiles } = useBrowser.getState();
  const profile = profiles[profileId];
  const link = doc.profiles[profileId];
  if (!app || !appReady(app) || !profile || !link || ownerOf(app, link.syncId).owner !== link.syncId) return false;
  return Object.entries(doc.profiles).every(([id, other]) => id === profileId || other.retire || !profiles[id] ||
    (other.syncId !== link.syncId && profiles[id]!.engineId !== profile.engineId));
}

function lockSpace(id: string) {
  if (useBrowser.getState().spaces[id]?.syncProfileLocked) return;
  useBrowser.setState((s) => useLegacyTopApps(s, id));
}

export function lockLinkedSpaces(doc: SyncDoc) {
  for (const [id, link] of Object.entries(doc.spaces)) {
    const space = useBrowser.getState().spaces[id];
    if (!space) continue;
    lockSpace(id);
    link.ownerSyncId ??= doc.profiles[space.profileId]?.syncId;
  }
}

export function enableSpace(doc: SyncDoc, id: string, includeData = false): boolean {
  const space = useBrowser.getState().spaces[id];
  if (!space || doc.preview || !doc.enabled || !SyncNative) return false;
  if (doc.spaces[id]) {
    doc.spaces[id] = { ...doc.spaces[id]!, enabled: true, retire: undefined };
    lockSpace(id);
    return true;
  }
  const owner = doc.profiles[space.profileId];
  const syncId = SyncNative.newDeviceId();
  doc.profiles[space.profileId] ??= { syncId, enabled: includeData };
  doc.spaces[id] = { syncId, ownerSyncId: owner?.syncId ?? syncId, enabled: true };
  lockSpace(id);
  return true;
}

function adoptLinkedSpace(doc: SyncDoc, id: string, syncId: string, ownerSyncId: string, record: SpaceRecord) {
  const app = doc.scopes[APP_SCOPE]!;
  doc.spaces[id] = { syncId, ownerSyncId, enabled: true, adopting: true };
  lockSpace(id);
  const shareTopApps = topAppsRecord(app.records[`pta:${syncId}`]?.v)?.on || undefined;
  const syncTabs = openTabsRecord(app.records[`ptab:${syncId}`]?.v)?.on || undefined;
  useBrowser.getState().updateSpace(id, { shareTopApps, syncTabs });
  (doc.scopes[spaceScope(syncId)] ??= emptyScope()).awaitRemote = true;
  if (!doc.joiningThemeChoices?.includes(id)) pairTheme(app, id, doc.spaces[id]!, record);
  else if (useBrowser.getState().spaces[id]?.theme === null) doc.spaces[id]!.keepPairingColor = true;
}

export function linkSpaces(doc: SyncDoc, app: ScopeState) {
  lockLinkedSpaces(doc);
  if (doc.initialized) {
    for (const [id, link] of Object.entries(doc.spaces)) if (!useBrowser.getState().spaces[id]) link.retire = true;
    for (const [id, link] of Object.entries(doc.profiles)) if (!useBrowser.getState().profiles[id]) link.retire = true;
    return;
  }
  if (!readyToPair(doc, app)) return;
  const s = useBrowser.getState();
  const remote = [...visible(app, "prof:")].flatMap(([key, value]) => {
    const record = profileRecord(value);
    return record ? [[key.slice(5), record] as const] : [];
  });
  const taken = new Set(Object.values(doc.spaces).map((link) => link.syncId));
  for (const id of s.spaceOrder) {
    const space = s.spaces[id];
    if (!space || doc.spaces[id]) continue;
    const [syncId, record] = doc.joining ? remote.find(([key, value]) => !taken.has(key) && (id === DEFAULT_SPACE_ID ? value.d : value.n === space.name)) ?? [] : [];
    if (syncId && record) {
      const { owner } = ownerOf(app, syncId);
      if (!owner) return;
      const current = doc.profiles[space.profileId];
      const linked = linkedProfileId(doc, owner);
      if ((!current || current.syncId === owner) && (!linked || linked === space.profileId)) {
        doc.profiles[space.profileId] ??= { syncId: owner, enabled: true, adopting: true };
        (doc.scopes[spaceScope(owner)] ??= emptyScope()).awaitRemote = true;
        adoptLinkedSpace(doc, id, syncId, owner, record);
        taken.add(syncId);
      }
    } else enableSpace(doc, id, true);
  }
  doc.initialized = true;
  doc.joining = false;
  delete doc.joiningThemeChoices;
}

export function addLinkedSpace(doc: SyncDoc, syncId: string): string | null {
  const record = remoteSpaceRecord(doc, syncId);
  if (!record || linkedSpaceId(doc, syncId)) return null;
  const { owner, sharesWith } = sharedDataChain(doc, syncId);
  if (!owner) return null;
  const app = doc.scopes[APP_SCOPE]!;
  const identity = identityRecord(app.records[profileKey(owner)]?.v) ?? profileRecord(app.records[`prof:${owner}`]?.v);
  if (!identity) return null;
  const profileId = sharesWith ?? useBrowser.getState().createProfile({ name: identity.n, icon: identity.i });
  if (!sharesWith) doc.profiles[profileId] = { syncId: owner, enabled: false, adopting: true };
  const id = useBrowser.getState().createSpace({ name: record.n, color: record.c, icon: record.i, profileId, shareTopApps: false });
  const theme = legacyThemeOf(record);
  if (theme) useBrowser.getState().updateSpace(id, theme);
  adoptLinkedSpace(doc, id, syncId, owner, record);
  return id;
}

const PAIRING_WAIT_MS = 86_400_000;
const pairingOverdue = (doc: SyncDoc, now: number) => doc.setupAt !== null && now - doc.setupAt > PAIRING_WAIT_MS;

export function appScopeOf(doc: SyncDoc, now = Date.now()): ScopeState {
  const app = (doc.scopes[APP_SCOPE] ??= { ...emptyScope(), awaitRemote: doc.joining });
  if (doc.joining && pairingOverdue(doc, now)) delete app.awaitRemote;
  return app;
}

export function readyToPair(doc: SyncDoc, app: ScopeState, now = Date.now()): boolean {
  if (!appReady(app)) return false;
  if (!doc.joining || pairingOverdue(doc, now)) return true;
  return [...visible(app, "prof:")].some(([key, value]) => profileRecord(value)?.d && !!ownerOf(app, key.slice(5)).owner);
}
