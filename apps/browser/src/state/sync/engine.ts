import { emptyScope, EXTENSION_PREFIX, folderTransport, syncScope, SyncNative, visible, type FolderInfo, type PhraseResult } from "../../platform/sync";
import { create } from "zustand";
import { useBrowser } from "../browser/store";
import { createProfileSync } from "./profileSync";
import { historyExpired } from "./historyAdapter";
import { settingsToReapply } from "./settingsAdapter";
import { appAdapters, spaceAdapters } from "./scopeAdapters";
import { APP_SCOPE, defaultTypes, emptyDoc, type DataType, type SendTarget, type SyncDoc, type SyncUi } from "./syncDoc";
import { syncFiles } from "./syncFiles";
import { settleThemeAdoption, themeChosenHere } from "./syncThemes";
import { editClock, startEditClock } from "./editClock";
import { addLinkedSpace, appScopeOf, dataOwnerMatches, enableSpace, lockLinkedSpaces, linkSpaces, readyToPair, spaceOwnerMatches } from "./spaceLinks";
import { summarize } from "./syncSummary";
import { takeCycleWork, timedCycle } from "./cycleWork";
import { freezeRemovals, markDeviceRemoved, markRemoved, settleRemovals, takeReturnedDeviceRemovals, takeReturnedProfileRemovals, takeSyncedDeviceRemovals, takeSyncedProfileRemovals } from "./profileRemoval";
import { profileScope, spaceScope } from "./records";
import { queueSend, sendTargetsIn } from "./sentTabs";
import { errorText } from "../../lib/errors";
import { isQuitting, saveBeforeQuit } from "../app/quit";
import { onProfilesOpened } from "../profiles/profileLoading";
import { markOpenTabsSynced, openTabsClosed, recordOpenTabCloses } from "./openTabCloses";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";

export { onTabsReceived } from "./sentTabs";
export { takeOpenTabSyncCounts } from "../telemetry/openTabSyncCounts";

const CYCLE_MS = 15_000;
const AFTER_EDIT_MS = 3_000;

export const useSync = create<SyncUi>()(() => ({
  status: SyncNative ? "off" : "unavailable",
  enabled: false,
  joining: false,
  folder: null,
  types: defaultTypes(),
  spaces: {},
  profiles: {},
  lastSyncedAt: null,
  error: null,
  pending: 0,
  devices: [],
  remoteTabs: {},
  remoteSpaces: [],
}));
export const currentSyncFolder = () => useSync.getState().folder;
let doc: SyncDoc = emptyDoc();
let cycle: Promise<void> | null = null;
let stateReady = false;
let restoring: Promise<void> | null = null;
let checkedForPreview = false;
let again = false;
let forcePasswordsNext = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let snapshotWrites = { count: 0, bytes: 0 };
const profileSync = createProfileSync(() => doc);
const { read, loadState, persistJournal, watchScope, save, startOver, checkpoint } = syncFiles(() => doc);

function noteSnapshot({ snapshotBytes }: { snapshotBytes: number }) {
  if (snapshotBytes) snapshotWrites = { count: snapshotWrites.count + 1, bytes: snapshotWrites.bytes + snapshotBytes };
}

export function takeSnapshotWrites() {
  const taken = { ...snapshotWrites, ...takeCycleWork(), removedProfiles: takeSyncedProfileRemovals(), removedDevices: takeSyncedDeviceRemovals(), removalsReturned: takeReturnedProfileRemovals() + takeReturnedDeviceRemovals() };
  snapshotWrites = { count: 0, bytes: 0 };
  return taken;
}

function load() {
  const loaded = read();
  if (loaded) doc = loaded;
}
function publishUi(patch: Partial<SyncUi> = {}) {
  useSync.setState({
    enabled: doc.enabled,
    joining: doc.enabled && doc.joining,
    folder: doc.folder,
    types: { ...doc.types },
    spaces: { ...doc.spaces },
    profiles: { ...doc.profiles },
    lastSyncedAt: doc.lastSyncedAt,
    ...(doc.enabled ? summarize(doc) : { devices: [], remoteTabs: {}, remoteSpaces: [], pending: 0 }),
    ...patch,
  });
}

function scheduleSync(delay = AFTER_EDIT_MS) {
  if (!doc.enabled || doc.preview || !stateReady) return;
  clearTimeout(timer);
  timer = setTimeout(() => void runCycle(), delay);
}
export async function syncNow() {
  if (!stateReady && useSync.getState().status === "stalled") await restoreSync();
  await runCycle({ forcePasswords: true });
}

type CycleOptions = { retiring?: boolean; forcePasswords?: boolean };

async function runCycle({ retiring = false, forcePasswords = false }: CycleOptions = {}) {
  if (!SyncNative || !doc.enabled || doc.preview || !stateReady || !doc.folder || !doc.deviceId) return;
  if (cycle) {
    again = true;
    forcePasswordsNext ||= forcePasswords;
    return;
  }
  const options = { retiring, forcePasswords: forcePasswords || forcePasswordsNext };
  forcePasswordsNext = false;
  cycle = timedCycle(Date.now(), cycleOnce(SyncNative, doc.folder, doc.deviceId, options));
  try {
    await cycle;
  } finally {
    cycle = null;
  }
}

async function cycleOnce(native: NonNullable<typeof SyncNative>, folder: string, device: string, { retiring, forcePasswords }: Required<CycleOptions>) {
  const consent = consentToken();
  clearTimeout(timer);
  const slow = setTimeout(() => useSync.getState().status === "updated" && publishUi({ status: "updating" }), 1000);
  try {
    const status = await native.chainStatus(folder);
    if (status === "unavailable") return publishUi({ status: "offline", error: null });
    if (status === "missing") return await resetFromElsewhere();
    const transport = folderTransport(native, folder);
    if (doc.joining && !checkedForPreview) {
      const preview = await transport.read("workspace-v2", []);
      if (preview.present?.length || preview.files.length || preview.pending?.length || preview.damaged?.length) {
        doc.preview = true;
        return publishUi({ status: "preview", error: "This folder contains sync data from a Profiles and Spaces preview. Its encrypted files have been kept." });
      }
      checkedForPreview = true;
    }
    if (editClock().device !== device) startEditClock(device, doc.clock);
    const clock = editClock();
    const app = appScopeOf(doc);
    if (freezeRemovals(doc)) save();
    const appSettled = watchScope(APP_SCOPE, app, clock);
    try {
      noteSnapshot(await syncScope({
        scope: APP_SCOPE,
        state: app,
        transport,
        adapters: appAdapters(doc, retiring),
        clock,
        device,
        options: { persist: persistJournal(APP_SCOPE), holdApply: isQuitting },
      }));
    } finally {
      await appSettled();
    }
    settleRemovals(doc, app);
    if (readyToPair(doc, app) && !isQuitting()) linkSpaces(doc, app);
    profileSync.watchExtensions();
    settleThemeAdoption(doc.spaces, app, true);
    let pending = app.pending;
    const scopes = new Map<string, { spaceId?: string; profileId?: string }>();
    for (const [spaceId, link] of Object.entries(doc.spaces)) {
      scopes.set(spaceScope(link.syncId), { spaceId });
    }
    if (!retiring) for (const [profileId, link] of Object.entries(doc.profiles)) {
      if (!link.enabled || link.retire || !dataOwnerMatches(doc, profileId)) continue;
      const name = profileScope(link.syncId);
      const entry = scopes.get(name) ?? {};
      if (!entry.profileId) scopes.set(name, { ...entry, profileId });
    }
    let blocked = false;
    for (const [scope, { spaceId, profileId }] of scopes) {
      const spaceLink = spaceId ? doc.spaces[spaceId] : undefined;
      const hasSpace = spaceId !== undefined && !!useBrowser.getState().spaces[spaceId];
      const retire = retiring || !!spaceLink?.retire || !hasSpace;
      const wantsSpace = !!spaceId && !!spaceLink && (retire || spaceLink.enabled);
      const matches = !retire && !!spaceId && spaceOwnerMatches(doc, spaceId);
      if (wantsSpace && !retire && !matches && spaceLink && app.records[`prof:${spaceLink.syncId}`]?.v) blocked = true;
      const layout = wantsSpace && (retire || matches) ? spaceAdapters(doc, spaceId!, retire) : [];
      const data = profileId ? profileSync.adapters(profileId, forcePasswords) : [];
      if (!layout.length && !data.length) continue;
      const state = (doc.scopes[scope] ??= emptyScope());
      const settled = watchScope(scope, state, clock);
      try {
        noteSnapshot(await syncScope({
          scope,
          state,
          transport,
          adapters: [...layout, ...data],
          clock,
          device,
          options: { expired: historyExpired, persist: persistJournal(scope), holdApply: isQuitting },
        }));
      } finally {
        await settled();
      }
      pending += state.pending;
      if (profileId && !isQuitting()) await profileSync.extensionsOf(profileId)?.reconcile(visible(state, EXTENSION_PREFIX), Date.now(), isQuitting);
      if (retire && spaceLink && spaceId) {
        delete spaceLink.retire;
        if (!hasSpace) {
          delete doc.spaces[spaceId];
          if (!profileId && !Object.values(doc.profiles).some((link) => profileScope(link.syncId) === scope)) {
            delete doc.scopes[scope];
            delete doc.sends?.[scope];
          }
        }
      }
    }
    doc.clock = clock.last;
    doc.lastSyncedAt = Date.now();
    publishUi({ status: blocked ? "stalled" : "updated", error: blocked ? "One or more spaces are waiting for their browsing profile to be verified." : null, pending });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_SYNC_FOLDER_UNREADABLE") {
      publishUi({ status: "offline", error: "The sync folder can’t be read. Check that it’s still there and that Ardia can open it." });
    } else if (useSync.getState().status !== "locked") {
      warnFor(consent, "[sync] cycle failed", error);
      publishUi({ status: "stalled", error: errorText(error) });
    }
  } finally {
    clearTimeout(slow);
    save();
    if (doc.enabled) {
      scheduleSync(again ? 0 : CYCLE_MS);
      again = false;
    }
  }
}
export function adoptProfileTheme(spaceId: string) {
  if (stateReady && !doc.preview && doc.joining && !doc.spaces[spaceId] && useBrowser.getState().spaces[spaceId]) {
    const choices = (doc.joiningThemeChoices ??= []);
    if (!choices.includes(spaceId)) {
      choices.push(spaceId);
      save();
    }
    return;
  }
  if (!themeChosenHere(doc.spaces[spaceId])) return;
  save();
  if (doc.enabled) scheduleSync(AFTER_EDIT_MS);
}

async function loadSavedState() {
  await loadState();
  lockLinkedSpaces(doc);
  startEditClock(doc.deviceId ?? "", doc.clock);
  const app = doc.scopes[APP_SCOPE];
  if (app) app.unapplied = [...new Set([...app.unapplied, ...settingsToReapply(app.records)])];
  settleThemeAdoption(doc.spaces, app, false);
  await checkpoint(true);
  stateReady = true;
}

function restoreSync() {
  if (restoring) return restoring;
  const deviceId = doc.deviceId;
  if (!SyncNative || !doc.enabled || !deviceId || doc.preview) return Promise.resolve();
  const consent = consentToken();
  restoring = SyncNative.unlock(deviceId).then(async (ok) => {
    if (!ok) {
      publishUi({ status: "locked", error: `Enter your recovery phrase to keep syncing on this ${PLATFORM_TERMS.computer}.` });
      return;
    }
    await loadSavedState();
    publishUi({ status: "starting", error: null });
    scheduleSync(500);
  }).catch((error: unknown) => {
    warnFor(consent, "[sync] loading the saved sync state failed", error);
    publishUi({ status: "stalled", error: errorText(error) });
  }).finally(() => { restoring = null; });
  return restoring;
}

function unlockLocalSpaces() {
  const s = useBrowser.getState();
  for (const space of Object.values(s.spaces)) if (space.syncProfileLocked) s.updateSpace(space.id, { syncProfileLocked: undefined });
}

async function resetFromElsewhere() {
  unlockLocalSpaces();
  await SyncNative?.forget(doc.deviceId!);
  doc = { ...emptyDoc(), folder: doc.folder, types: doc.types };
  startOver();
  publishUi({ status: "reset", error: "This device is out of sync. Sync may have been reset from another device." });
}
export async function folderInfo(path?: string | null): Promise<FolderInfo | null> {
  return (await SyncNative?.folderInfo(path ?? doc.folder ?? null)) ?? null;
}
function setSyncFolder(path: string) {
  if (doc.enabled) return;
  doc.folder = path;
  save();
  publishUi();
}
export async function chooseSyncFolder(): Promise<string | null> {
  const picked = (await SyncNative?.chooseFolder(doc.folder)) ?? null;
  if (picked) setSyncFolder(picked);
  return picked;
}
function begin(folder: string, deviceId: string, joining: boolean) {
  doc = { ...emptyDoc(), types: doc.types, enabled: true, folder, deviceId, setupAt: Date.now(), joining };
  startOver();
  checkedForPreview = false;
  stateReady = true;
  publishUi({ status: "starting", error: null });
  scheduleSync(0);
}
export async function turnOnSync(folder: string): Promise<{ ok: true } | { error: string }> {
  const native = SyncNative;
  if (doc.preview) return { error: "This device has saved sync data from a Profiles and Spaces preview." };
  if (!native) return { error: "Sync isn’t available in this build." };
  const deviceId = native.newDeviceId();
  try {
    if (!(await native.createPhrase(deviceId))) return { error: `Couldn’t save the sync key in ${PLATFORM_TERMS.secretStore}.` };
    await native.createChain(folder);
  } catch (error) {
    await native.forget(deviceId);
    return { error: `Couldn’t use that folder: ${errorText(error)}` };
  }
  begin(folder, deviceId, false);
  return { ok: true };
}
export async function enterRecoveryPhrase(folder: string, text: string): Promise<PhraseResult | { error: "unavailable" }> {
  const native = SyncNative;
  if (!native || doc.preview) return { error: "unavailable" };
  if (doc.enabled && doc.deviceId && useSync.getState().status === "locked") {
    const result = await native.enterPhrase(doc.deviceId, text, doc.folder ?? folder);
    if ("ok" in result) {
      try { await loadSavedState(); } catch (error) {
        publishUi({ status: "stalled", error: errorText(error) });
        return result;
      }
      publishUi({ status: "starting", error: null });
      scheduleSync(0);
    }
    return result;
  }
  const deviceId = native.newDeviceId();
  const result = await native.enterPhrase(deviceId, text, folder);
  if ("ok" in result) begin(folder, deviceId, true);
  return result;
}
export async function stopSync({ deleteData = false } = {}) {
  const native = SyncNative;
  if (!native || !doc.enabled || doc.preview || !stateReady) return;
  clearTimeout(timer);
  const consent = consentToken();
  const reportFailure = (error: unknown) => warnFor(consent, "[sync] the last cycle before stopping failed", error);
  while (cycle) await cycle.catch(reportFailure);
  if (useSync.getState().status !== "locked") await runCycle({ retiring: true }).catch(reportFailure);
  clearTimeout(timer);
  const folder = doc.folder;
  if (deleteData && folder) {
    try {
      await native.deleteChain(folder);
    } catch (error) {
      warnFor(consent, "[sync] deleting sync data failed", error);
    }
  }
  if (doc.deviceId) await native.forget(doc.deviceId);
  unlockLocalSpaces();
  doc = { ...emptyDoc(), folder, types: doc.types };
  profileSync.clear();
  startOver();
  publishUi({ status: "off", error: null });
}

const docChanged = () => void (save(), publishUi(), scheduleSync(0));

export function setTypeSynced(type: DataType, enabled: boolean) {
  if (!stateReady || doc.preview) return;
  doc.types = { ...doc.types, [type]: enabled };
  docChanged();
}
export function setSpaceSynced(spaceId: string, enabled: boolean) {
  if (!stateReady || doc.preview || doc.joining) return;
  const link = doc.spaces[spaceId];
  if (!link) {
    if (enabled && enableSpace(doc, spaceId)) docChanged();
    return;
  }
  const { retire: _retire, ...kept } = link;
  doc.spaces[spaceId] = enabled ? { ...kept, enabled } : { ...link, enabled, retire: true };
  docChanged();
}

export function setOpenTabsSynced(spaceId: string, on: boolean) {
  if (!stateReady || doc.preview) return;
  markOpenTabsSynced(doc, spaceId, on);
  docChanged();
}

export function sendTargets(spaceId: string): SendTarget[] {
  return !stateReady || doc.preview || !spaceOwnerMatches(doc, spaceId) ? [] : sendTargetsIn(doc, spaceId);
}

export function sendTab(tabId: string, deviceId: string): boolean {
  const spaceId = useBrowser.getState().tabs[tabId]?.spaceId;
  if (!spaceId || !stateReady || doc.preview || !spaceOwnerMatches(doc, spaceId) || !queueSend(doc, tabId, deviceId)) return false;
  save();
  scheduleSync(0);
  return true;
}
export function setProfileSynced(profileId: string, enabled: boolean) {
  if (!stateReady || doc.preview) return;
  const link = doc.profiles[profileId];
  if (!link) return;
  doc.profiles[profileId] = { ...link, enabled, retire: undefined };
  save(); publishUi(); scheduleSync(0);
}
export const appScopeRecords = () => doc.scopes[APP_SCOPE]?.records ?? {};
export function addRemoteSpace(syncId: string): string | null {
  if (!stateReady || doc.preview) return null;
  const id = addLinkedSpace(doc, syncId);
  if (id) docChanged();
  return id;
}

export const removeRemoteProfile = (syncId: string): boolean => stateReady && !doc.preview && markRemoved(doc, syncId) && (docChanged(), true);
export const removeRemoteSpace = removeRemoteProfile;
export const removeSyncedDevice = (id: string): boolean => stateReady && !doc.preview && markDeviceRemoved(doc, id) && (docChanged(), true);

export function startSync() {
  if (!SyncNative) return;
  load();
  stateReady = false;
  checkedForPreview = false;
  if (doc.preview) {
    publishUi({ status: "preview", error: "This device has saved sync data from a Profiles and Spaces preview. Its encrypted files have been kept." });
    return;
  }
  if (doc.enabled) lockLinkedSpaces(doc);
  else unlockLocalSpaces();
  publishUi({ status: doc.enabled ? "starting" : "off" });
  if (doc.enabled && doc.deviceId) void restoreSync();
  saveBeforeQuit(() => stateReady ? checkpoint() : Promise.resolve());
  onProfilesOpened(() => {
    if (!doc.enabled || !doc.deviceId) return;
    void profileSync.watchExtensions();
    scheduleSync();
  });
  useBrowser.subscribe((s, prev) => {
    if (!doc.enabled || doc.preview || !stateReady) return;
    const closed = !isQuitting() && recordOpenTabCloses(doc, openTabsClosed(s, prev));
    if (closed && !cycle) save();
    if (closed || (!cycle && (s.bookmarks !== prev.bookmarks || s.settings !== prev.settings || s.profiles !== prev.profiles || s.spaces !== prev.spaces || s.spaceOrder !== prev.spaceOrder || s.topApps !== prev.topApps || s.groups !== prev.groups))) scheduleSync();
  });
  if (__DEV__) {
    (globalThis as { acSync?: object }).acSync = {
      useSync, syncNow, turnOnSync, enterRecoveryPhrase, stopSync, setTypeSynced, setProfileSynced, setSpaceSynced, setOpenTabsSynced, addRemoteSpace, removeRemoteProfile, removeSyncedDevice, setSyncFolder, folderInfo,
      doc: () => doc,
      native: SyncNative,
      get menu(): typeof import("./menu") {
        return require("./menu");
      },
    };
  }
}
