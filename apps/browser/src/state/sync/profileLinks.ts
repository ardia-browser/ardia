import { emptyScope, holdsBack, SyncNative, visible, type ScopeState } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import { DEFAULT_PROFILE_ID } from "../settings/settings";
import { PROFILE, PROFILE_OPEN_TABS, PROFILE_TOP_APPS, SHARE, openTabsRecord, profileRecord, profileScope, recordId, shareRecord, topAppsRecord } from "./records";
import type { ProfileRecord } from "./profileAdapters";
import { APP_SCOPE, type SyncDoc } from "./syncDoc";
import { pairTheme } from "./syncThemes";
import { noteTopAppsSharingFromSync, startedBySync } from "../telemetry/topAppsSharing";
import { noteJoinWait } from "../telemetry/syncSafetyCounts";
import { oweRebase } from "./rebaseObligations";
import type { ConsentToken } from "../telemetry/consentPeriod";

const remoteTopApps = (doc: SyncDoc, syncId: string) => topAppsRecord(doc.scopes[APP_SCOPE]?.records[`${PROFILE_TOP_APPS}${syncId}`]?.v);

const remoteOpenTabs = (doc: SyncDoc, syncId: string) => openTabsRecord(doc.scopes[APP_SCOPE]?.records[`${PROFILE_OPEN_TABS}${syncId}`]?.v);

export const remoteProfileRecord = (doc: SyncDoc, syncId: string) => profileRecord(doc.scopes[APP_SCOPE]?.records[`${PROFILE}${syncId}`]?.v) ?? undefined;

const sharedDataOwner = (doc: SyncDoc, syncId: string): string | null => {
  const owner = shareRecord(doc.scopes[APP_SCOPE]?.records[`${SHARE}${syncId}`]?.v)?.o;
  return owner && owner !== syncId ? owner : null;
};

export const linkedProfileId = (doc: SyncDoc, syncId: string): string | null => {
  const profiles = useBrowser.getState().profiles;
  return Object.entries(doc.profiles).find(([id, link]) => link.syncId === syncId && !link.retire && profiles[id])?.[0] ?? null;
};

export function sharedDataChain(doc: SyncDoc, syncId: string): { adds: string[]; sharesWith: string | null; waitingFor?: string } {
  const adds = [syncId];
  for (let at = syncId; ; ) {
    const owner = sharedDataOwner(doc, at);
    if (!owner) return { adds, sharesWith: null };
    const here = linkedProfileId(doc, owner);
    if (here) return { adds, sharesWith: here };
    if (!remoteProfileRecord(doc, owner)) return { adds, sharesWith: null, waitingFor: owner };
    if (adds.includes(owner)) {
      const lowest = adds.slice(adds.indexOf(owner)).sort()[0]!;
      return { adds: adds.slice(0, adds.indexOf(lowest) + 1), sharesWith: null };
    }
    adds.push(owner);
    at = owner;
  }
}

const PAIRING_WAIT_MS = 86_400_000;

const pairingOverdue = (doc: SyncDoc, now: number) => doc.setupAt !== null && now - doc.setupAt > PAIRING_WAIT_MS;

export function appScopeOf(doc: SyncDoc, consent: ConsentToken | null = null, now = Date.now()): ScopeState {
  const app = (doc.scopes[APP_SCOPE] ??= { ...emptyScope(), awaitRemote: doc.joining });
  if (doc.joining && pairingOverdue(doc, now)) delete app.awaitRemote;
  if (app.awaitRemote && app.pending) noteJoinWait(consent);
  return app;
}

export function readyToPair(doc: SyncDoc, app: ScopeState, now = Date.now()): boolean {
  if (!doc.joining || pairingOverdue(doc, now)) return true;
  const synced = [...visible(app, PROFILE).values()].flatMap((v) => profileRecord(v) ?? []);
  return synced.length > 0 && !holdsBack(app, now, PAIRING_WAIT_MS);
}

export function linkProfiles(doc: SyncDoc, app: ScopeState) {
  const s = useBrowser.getState();
  const remote = [...visible(app, PROFILE)].flatMap(([k, v]) => {
    const record = profileRecord(v);
    return record ? [[recordId(PROFILE, k), record] as const] : [];
  });
  const taken = new Set(Object.values(doc.profiles).map((l) => l.syncId));
  for (const id of s.profileOrder) {
    const profile = s.profiles[id];
    if (!profile || isIncognitoProfile(id) || doc.profiles[id]) continue;
    const [match] = doc.joining
      ? (remote.find(([syncId, r]) => !taken.has(syncId) && (id === DEFAULT_PROFILE_ID ? r.d : r.n === profile.name)) ?? [])
      : [];
    const syncId = match ?? SyncNative!.newDeviceId();
    doc.profiles[id] = { syncId, enabled: true };
    taken.add(syncId);
    const topApps = match ? remoteTopApps(doc, match) : null;
    if (topApps && topApps.on !== !!profile.shareTopApps) {
      startedBySync(() => s.updateProfile(id, { shareTopApps: topApps.on || undefined }));
      noteTopAppsSharingFromSync(useBrowser.getState(), "link_profiles", topApps.on);
    }
    const openTabs = match ? remoteOpenTabs(doc, match) : null;
    if (openTabs && openTabs.on !== !!profile.syncTabs) s.updateProfile(id, { syncTabs: openTabs.on || undefined });
    if (match) {
      doc.scopes[profileScope(syncId)] = { ...emptyScope(), awaitRemote: true };
      if (!doc.themesChosenWhileJoining?.includes(id)) pairTheme(app, id, doc.profiles[id]!);
    }
  }
  delete doc.themesChosenWhileJoining;
  doc.joining = false;
}

export function retireDeletedProfile(doc: SyncDoc, profileId: string): boolean {
  const link = doc.profiles[profileId];
  if (!link || link.retire) return false;
  link.retire = true;
  return true;
}

export const dormantLink = (doc: SyncDoc, id: string) => !!doc.profiles[id] && !doc.profiles[id]!.retire && !useBrowser.getState().profiles[id];

export function addSyncedProfile(doc: SyncDoc, syncId: string): string | null | undefined {
  if (!remoteProfileRecord(doc, syncId) || linkedProfileId(doc, syncId)) return undefined;
  const { adds, sharesWith, waitingFor } = sharedDataChain(doc, syncId);
  if (waitingFor) return undefined;
  let shareWith = sharesWith;
  for (const add of adds.reverse()) shareWith = addLinkedProfile(doc, add, remoteProfileRecord(doc, add)!, shareWith);
  return shareWith;
}

export function addLinkedProfile(doc: SyncDoc, syncId: string, record: ProfileRecord, shareWith: string | null): string {
  const shareTopApps = remoteTopApps(doc, syncId)?.on;
  const missing = Object.keys(doc.profiles).find((id) => doc.profiles[id]!.syncId === syncId && dormantLink(doc, id));
  const id = startedBySync(() => useBrowser.getState().createProfile({ id: missing, name: record.n, color: record.c, icon: record.i, shareWith, shareTopApps }));
  if (shareTopApps) noteTopAppsSharingFromSync(useBrowser.getState(), "linked_profile_created", true);
  if (remoteOpenTabs(doc, syncId)?.on) useBrowser.getState().updateProfile(id, { syncTabs: true });
  if (missing && missing !== id) delete doc.profiles[missing];
  doc.profiles[id] = { syncId, enabled: true };
  pairTheme(doc.scopes[APP_SCOPE], id, doc.profiles[id]!, record);
  const previous = doc.scopes[profileScope(syncId)];
  doc.scopes[profileScope(syncId)] = freshScopeAfter(previous, doc.deviceId ?? "");
  if (previous) oweRebase(doc, [profileScope(syncId)]);
  return id;
}

function freshScopeAfter(before: ScopeState | undefined, device: string): ScopeState {
  const fresh: ScopeState = { ...emptyScope(), awaitRemote: true };
  if (!before) return fresh;
  const records: ScopeState["records"] = {};
  const queued = [...(before.journal ?? []).map((file) => ({ ops: file.ops, o: [file.device, file.seq] as [string, number] })), { ops: before.outbox, o: [device, before.seq + 1] as [string, number] }];
  for (const { ops, o } of queued) for (const op of ops) if (!records[op.k] || records[op.k]!.h < op.h) records[op.k] = { h: op.h, v: op.v, o };
  return { ...fresh, seq: before.seq, outbox: before.outbox, records, unapplied: Object.keys(records), ...(before.journal?.length ? { journal: before.journal } : {}) };
}
