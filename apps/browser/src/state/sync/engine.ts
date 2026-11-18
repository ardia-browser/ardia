import { emptyScope, EXTENSION_PREFIX, folderTransport, syncScope, SyncNative, visible, type FolderInfo, type PhraseResult } from "../../platform/sync";
import { create } from "zustand";
import { useBrowser } from "../browser/store";
import { confirm } from "../app/system";
import { assignmentChoices } from "./assignmentChoices";
import { importLegacySync } from "./legacySync";
import { createProfileSync } from "./profileSync";
import { historyExpired } from "./historyAdapter";
import { settingsToReapply } from "./settingsAdapter";
import { appAdapters, spaceAdapters } from "./scopeAdapters";
import { APP_SCOPE, defaultTypes, emptyDoc, type DataType, type SendTarget, type SyncDoc, type SyncUi } from "./syncDoc";
import { syncFiles } from "./syncFiles";
import { settleThemeAdoption, themeChosenHere } from "./syncThemes";
import { editClock, startEditClock } from "./editClock";
import { addLinkedSpace, appScopeOf, linkedSpaceId, linkSpaces, readyToPair, remoteSpaceRecord, sharedDataChain } from "./spaceLinks";
import { summarize } from "./syncSummary";
import { takeCycleWork, timedCycle } from "./cycleWork";
import { freezeRemovals, markDeviceRemoved, markRemoved, settleRemovals, takeReturnedDeviceRemovals, takeReturnedProfileRemovals, takeSyncedDeviceRemovals, takeSyncedProfileRemovals } from "./profileRemoval";
import { profileScope, spaceScope } from "./records";
import { queueSend, sendTargetsIn } from "./sentTabs";
import { errorText } from "../../lib/errors";
import { isQuitting, saveBeforeQuit } from "../app/quit";
import { onProfilesOpened, profileOpened } from "../profiles/profileLoading";
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
let again = false;
let forcePasswordsNext = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let snapshotWrites = { count: 0, bytes: 0 };
const profileSync = createProfileSync(() => doc);
const { read, loadState, persistJournal, watchScope, save, startOver, checkpoint } = syncFiles(() => doc);
export const { keepSpaceProfile, acceptSpaceProfile } = assignmentChoices(() => doc, () => docChanged());

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
  if (!doc.enabled) return;
  clearTimeout(timer);
  timer = setTimeout(() => void runCycle(), delay);
}
export async function syncNow() {
  await runCycle({ forcePasswords: true });
}

type CycleOptions = { retiring?: boolean; forcePasswords?: boolean };

async function runCycle({ retiring = false, forcePasswords = false }: CycleOptions = {}) {
  if (!SyncNative || !doc.enabled || !doc.protocolReady || !doc.folder || !doc.deviceId || useSync.getState().status === "locked") return;
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
    await profileSync.watchExtensions();
    const status = await native.chainStatus(folder);
    if (status === "unavailable") return publishUi({ status: "offline", error: null });
    if (status === "missing") return await resetFromElsewhere();
    const transport = folderTransport(native, folder);
    if (editClock().device !== device) startEditClock(device, doc.clock);
    const clock = editClock();
    await importLegacySync(doc);
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
    if (app.joined && readyToPair(doc, app) && !isQuitting()) { linkSpaces(doc, app);
    doc.joining = false; }
    settleThemeAdoption(doc.spaces, app, true);
    let pending = app.pending;
    const s = useBrowser.getState();
    for (const [spaceId, link] of Object.entries(doc.spaces)) {
      const exists = !!s.spaces[spaceId];
      const retire = retiring || !!link.retire || !exists;
      if (!retire && !link.enabled) continue;
      const scope = spaceScope(link.syncId);
      const state = (doc.scopes[scope] ??= emptyScope());
      const settled = watchScope(scope, state, clock);
      try {
        noteSnapshot(await syncScope({
          scope,
          state,
          transport,
          adapters: spaceAdapters(doc, spaceId, retire),
          clock,
          device,
          options: { expired: historyExpired, persist: persistJournal(scope), holdApply: isQuitting },
        }));
      } finally {
        await settled();
      }
      pending += state.pending;
      if (retire) {
        delete link.retire;
        if (!exists) {
          delete doc.scopes[scope];
          delete doc.sends?.[scope];
          delete doc.spaces[spaceId];
        }
      }
    }
    if (!retiring) for (const [profileId, link] of Object.entries(doc.profiles)) {
      if (!s.profiles[profileId] || !link.enabled && !link.topAppsEnabled || link.retire) continue;
      const scope = profileScope(link.syncId);
      const state = doc.scopes[scope] ??= emptyScope();
      const settled = watchScope(scope, state, clock);
      try {
        await syncScope({ scope, state, transport, adapters: profileSync.adapters(profileId, forcePasswords), clock, device, options: { expired: historyExpired, persist: persistJournal(scope), holdApply: isQuitting } });
      } finally { await settled(); }
      pending += state.pending;
      if (!isQuitting() && link.enabled && doc.types.extensions && profileOpened(s.profiles[profileId]!.engineId)) {
        await profileSync.extensionsOf(profileId).reconcile(visible(state, EXTENSION_PREFIX), Date.now(), isQuitting);
      }
    }
    doc.clock = clock.last;
    doc.lastSyncedAt = Date.now();
    publishUi({ status: "updated", error: null, pending });
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
  if (!themeChosenHere(doc.spaces[spaceId])) return;
  save();
  if (doc.enabled) scheduleSync(AFTER_EDIT_MS);
}

async function loadSavedState() {
  await loadState();
  startEditClock(doc.deviceId ?? "", doc.clock);
  const app = doc.scopes[APP_SCOPE];
  if (app) app.unapplied = [...new Set([...app.unapplied, ...settingsToReapply(app.records)])];
  settleThemeAdoption(doc.spaces, app, false);
}

async function resetFromElsewhere() {
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
  publishUi({ status: "starting", error: null });
  scheduleSync(0);
}
export async function turnOnSync(folder: string): Promise<{ ok: true } | { error: string }> {
  const native = SyncNative;
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
  if (!native) return { error: "unavailable" };
  if (doc.enabled && doc.deviceId && useSync.getState().status === "locked") {
    const result = await native.enterPhrase(doc.deviceId, text, doc.folder ?? folder);
    if ("ok" in result) {
      if (!doc.protocolReady) { publishUi({ status: "upgrade", error: null }); return result; }
      await loadSavedState();
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
  if (!native || !doc.enabled) return;
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
  doc = { ...emptyDoc(), folder, types: doc.types };
  profileSync.clear();
  startOver();
  publishUi({ status: "off", error: null });
}

const docChanged = () => void (save(), publishUi(), scheduleSync(0));

export function setTypeSynced(type: DataType, enabled: boolean) {
  doc.types = { ...doc.types, [type]: enabled };
  docChanged();
}
export function setSpaceSynced(spaceId: string, enabled: boolean) {
  const link = doc.spaces[spaceId];
  if (!link) return;
  const { retire: _retire, ...kept } = link;
  doc.spaces[spaceId] = enabled ? { ...kept, enabled } : { ...link, enabled, retire: true };
  docChanged();
}

export function setOpenTabsSynced(spaceId: string, on: boolean) {
  markOpenTabsSynced(doc, spaceId, on);
  docChanged();
}

export function sendTargets(spaceId: string): SendTarget[] {
  return useSync.getState().status === "locked" ? [] : sendTargetsIn(doc, spaceId);
}

export function sendTab(tabId: string, deviceId: string): boolean {
  if (useSync.getState().status === "locked" || !queueSend(doc, tabId, deviceId)) return false;
  save();
  scheduleSync(0);
  return true;
}
export function setProfileSynced(profileId: string, enabled: boolean) {
  const link = doc.profiles[profileId];
  if (!link) return;
  doc.profiles[profileId] = { ...link, enabled, retire: undefined };
  save(); publishUi(); scheduleSync(0);
}
export function setTopAppsSynced(profileId: string, enabled: boolean) {
  const link = doc.profiles[profileId];
  if (!link) return;
  doc.profiles[profileId] = { ...link, topAppsEnabled: enabled, retire: undefined };
  save(); publishUi(); scheduleSync(0);
}
export async function upgradeSync() {
  const result = await confirm({ title: "Use Spaces sync on your Macs?", message: "Every Mac must use an Ardia build with separate Profiles and Spaces. Older builds keep their own sync data and cannot send new changes to this build. The existing encrypted files will be kept.", confirmTitle: "Use Spaces Sync" });
  if (!result.confirmed || !doc.deviceId) return;
  if (!await SyncNative?.unlock(doc.deviceId)) return publishUi({ status: "locked", error: "Enter your recovery phrase before upgrading sync." });
  const legacyPending = doc.legacyPending;
  try { await loadState(); await importLegacySync(doc); await checkpoint(true); }
  catch (error) { if (legacyPending) doc.legacyPending = true; publishUi({ status: "upgrade", error: errorText(error) }); return; }
  doc.protocolReady = true;
  save();
  publishUi({ status: "starting", error: null });
  scheduleSync(0);
}
export const appScopeRecords = () => doc.scopes[APP_SCOPE]?.records ?? {};
export function addRemoteSpace(syncId: string): string | null {
  if (!remoteSpaceRecord(doc, syncId) || linkedSpaceId(doc, syncId)) return null;
  const { adds, sharesWith, waitingFor } = sharedDataChain(doc, syncId);
  if (waitingFor) return null;
  let shareWith = sharesWith;
  for (const add of adds.reverse()) shareWith = addLinkedSpace(doc, add, remoteSpaceRecord(doc, add)!, shareWith);
  docChanged();
  return shareWith;
}

export const removeRemoteProfile = (syncId: string): boolean => markRemoved(doc, syncId) && (docChanged(), true);
export const removeRemoteSpace = removeRemoteProfile;
export const removeSyncedDevice = (id: string): boolean => markDeviceRemoved(doc, id) && (docChanged(), true);

export function startSync() {
  if (!SyncNative) return;
  load();
  publishUi({ status: doc.enabled ? doc.protocolReady ? "starting" : "upgrade" : "off" });
  void profileSync.watchExtensions();
  if (doc.enabled && doc.protocolReady && doc.deviceId) {
    const consent = consentToken();
    void SyncNative.unlock(doc.deviceId)
      .then(async (ok) => {
        if (!ok) return publishUi({ status: "locked", error: `Enter your recovery phrase to keep syncing on this ${PLATFORM_TERMS.computer}.` });
        await loadSavedState();
        publishUi();
        scheduleSync(500);
      })
      .catch((error: unknown) => {
        warnFor(consent, "[sync] unlocking at launch failed", error);
        publishUi({ status: "stalled", error: errorText(error) });
      });
  }
  saveBeforeQuit(checkpoint);
  onProfilesOpened(() => {
    if (!doc.enabled || !doc.deviceId) return;
    void profileSync.watchExtensions();
    scheduleSync();
  });
  useBrowser.subscribe((s, prev) => {
    if (!doc.enabled || !doc.protocolReady) return;
    const closed = !isQuitting() && recordOpenTabCloses(doc, openTabsClosed(s, prev));
    if (closed && !cycle) save();
    if (closed || (!cycle && (s.bookmarks !== prev.bookmarks || s.settings !== prev.settings || s.profiles !== prev.profiles || s.spaces !== prev.spaces || s.spaceOrder !== prev.spaceOrder || s.topApps !== prev.topApps || s.groups !== prev.groups))) scheduleSync();
  });
  if (__DEV__) {
    (globalThis as { acSync?: object }).acSync = {
      useSync, syncNow, turnOnSync, enterRecoveryPhrase, stopSync, setTypeSynced, setProfileSynced, setSpaceSynced, setTopAppsSynced, setOpenTabsSynced, upgradeSync, addRemoteSpace, removeRemoteProfile, removeSyncedDevice, setSyncFolder, folderInfo,
      doc: () => doc,
      native: SyncNative,
      get menu(): typeof import("./menu") {
        return require("./menu");
      },
    };
  }
}
