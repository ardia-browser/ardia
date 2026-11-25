import { asSecret, reveal, type Secret } from "@ardia/core";
import { emptyScope, EXTENSION_PREFIX, folderTransport, syncScope, SyncNative, visible, type FolderInfo, type PhraseResult } from "../../platform/sync";
import { create } from "zustand";
import { useBrowser } from "../browser/store";
import { engineProfile } from "../browser/model";
import { historyExpired } from "./historyAdapter";
import { settleRetiredDefaultsWithoutSync, settleSettingsFromSavedSync } from "./settingsAdapter";
import { watchExtensionIntents } from "./extensions";
import { appAdapters, extensionsOf, forgetScopeAdapters, profileAdapters, typeSynced } from "./scopeAdapters";
import { APP_SCOPE, emptyDoc, emptyUi, typeSyncedFor, type DataType, type SendTarget, type SyncDoc, type SyncUi } from "./syncDoc";
import { syncFiles } from "./syncFiles";
import { settleThemeAdoption, themeChosenHere } from "./syncThemes";
import { editClock, startEditClock } from "./editClock";
import { addLinkedProfile, appScopeOf, linkedProfileId, linkProfiles, readyToPair, remoteProfileRecord, sharedDataChain } from "./profileLinks";
import { summarize } from "./syncSummary";
import { noteSnapshot, timedCycle } from "./cycleWork";
import { exposeDevSync } from "./devSync";
import { folderScopes, moveChain, noteFolderMove, noteTurnOn, type FolderMoveResult, type TurnOnFolder } from "./folderMove";
import { freezeRemovals, markDeviceRemoved, markRemoved, settleRemovals } from "./profileRemoval";
import { profileScope } from "./records";
import { queueSend, sendTargetsIn } from "./sentTabs";
import { errorText } from "../../lib/errors";
import { isQuitting, saveBeforeQuit } from "../app/quit";
import { onProfilesOpened, profileOpened } from "../profiles/profileLoading";
import { markOpenTabsSynced, openTabsClosed, recordOpenTabCloses } from "./openTabCloses";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";

export { onTabsReceived } from "./sentTabs";
export { takeSnapshotWrites } from "./cycleWork";
export { takeOpenTabSyncCounts } from "../telemetry/openTabSyncCounts";

const CYCLE_MS = 15_000;
const AFTER_EDIT_MS = 3_000;

export const useSync = create<SyncUi>()(() => emptyUi(SyncNative ? "off" : "unavailable"));
export const whenSyncCore = <Consent>(consent: Consent, emit: (core: "rust" | "native", consent: Consent) => void) => emit(SyncNative?.core === "rust" ? "rust" : "native", consent);

export const currentSyncFolder = () => useSync.getState().folder;

let doc: SyncDoc = emptyDoc();
let cycle: Promise<void> | null = null;
let again = false;
let forcePasswordsNext = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const { read, loadState, persistJournal, watchScope, save, startOver, checkpoint } = syncFiles(() => doc);

function load() {
  const loaded = read();
  if (loaded) doc = loaded;
}

function publishUi(patch: Partial<SyncUi> = {}) {
  if (!doc.enabled || !typeSyncedFor(doc.types, "settings", true)) settleRetiredDefaultsWithoutSync();
  useSync.setState({
    enabled: doc.enabled,
    joining: doc.enabled && doc.joining,
    folder: doc.folder,
    types: { ...doc.types },
    profiles: { ...doc.profiles },
    lastSyncedAt: doc.lastSyncedAt,
    ...(doc.enabled ? summarize(doc) : { devices: [], remoteTabs: {}, remoteProfiles: [], pending: 0 }),
    ...patch,
  });
}

function watchExtensions() {
  if (!doc.enabled) return;
  const s = useBrowser.getState();
  const watched = Object.entries(doc.profiles).filter(([id, l]) => l.enabled && s.profiles[id] && typeSynced(doc, "extensions", id));
  const profiles = [...new Set(watched.map(([id]) => engineProfile(s, id)))].filter((engine) => profileOpened(engine));
  if (profiles.length) watchExtensionIntents(profiles);
}

function scheduleSync(delay = AFTER_EDIT_MS) {
  if (!doc.enabled) return;
  clearTimeout(timer);
  timer = setTimeout(() => void runCycle(), delay);
}

let stopping = false;
let moveRun: Promise<FolderMoveResult> | null = null;
const moveSettled = async () => {
  while (moveRun) await moveRun.catch(() => {});
};

export const syncWritesOpen = () => doc.enabled && !stopping && !["starting", "locked", "off", "unavailable"].includes(useSync.getState().status);

export async function syncNow(stillWanted: () => void = () => {}): Promise<boolean> {
  while (moveRun || cycle) await (moveRun ?? cycle)!.catch(() => {});
  if (stopping || !doc.enabled || useSync.getState().status === "locked") return false;
  stillWanted();
  await runCycle({ forcePasswords: true });
  return true;
}

type CycleOptions = { retiring?: boolean; forcePasswords?: boolean };

async function runCycle({ retiring = false, forcePasswords = false }: CycleOptions = {}) {
  if (!SyncNative || !doc.enabled || moveRun || !doc.folder || !doc.deviceId || useSync.getState().status === "locked") return;
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
    watchExtensions();
    const status = await native.chainStatus(folder);
    if (status === "unavailable") return publishUi({ status: "offline", error: null });
    if (status === "missing") return await resetFromElsewhere();
    const transport = folderTransport(native, folder);
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
    if (app.joined && readyToPair(doc, app) && !isQuitting()) linkProfiles(doc, app);
    settleThemeAdoption(doc.profiles, app, true);
    let pending = app.pending;
    const s = useBrowser.getState();
    for (const [profileId, link] of Object.entries(doc.profiles)) {
      const exists = !!s.profiles[profileId];
      const retire = retiring || !!link.retire || !exists;
      if (!retire && !link.enabled) continue;
      const scope = profileScope(link.syncId);
      const state = (doc.scopes[scope] ??= emptyScope());
      const settled = watchScope(scope, state, clock);
      try {
        noteSnapshot(await syncScope({
          scope,
          state,
          transport,
          adapters: profileAdapters(doc, profileId, retire, forcePasswords),
          clock,
          device,
          options: { expired: historyExpired, persist: persistJournal(scope), holdApply: isQuitting },
        }));
      } finally {
        await settled();
      }
      pending += state.pending;
      if (!retire && !isQuitting() && typeSynced(doc, "extensions", profileId) && profileOpened(engineProfile(useBrowser.getState(), profileId))) await extensionsOf(profileId).reconcile(visible(state, EXTENSION_PREFIX), Date.now(), isQuitting);
      if (retire) {
        delete link.retire;
        if (!exists) {
          delete doc.scopes[scope];
          delete doc.sends?.[scope];
          delete doc.profiles[profileId];
        }
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

export function adoptProfileTheme(profileId: string) {
  if (!themeChosenHere(doc.profiles[profileId])) return;
  save();
  if (doc.enabled) scheduleSync(AFTER_EDIT_MS);
}

async function loadSavedState() {
  const loading = doc;
  const installed = await loadState(loading);
  startEditClock(doc.deviceId ?? "", doc.clock);
  settleSettingsFromSavedSync(doc.scopes[APP_SCOPE], installed && doc === loading && doc.enabled && !stopping && typeSyncedFor(doc.types, "settings", true));
  settleThemeAdoption(doc.profiles, doc.scopes[APP_SCOPE], false);
}

async function resetFromElsewhere() {
  await SyncNative?.forget(doc.deviceId!);
  doc = { ...emptyDoc(), folder: doc.folder, types: doc.types };
  startOver();
  publishUi({ status: "reset", error: "This device is out of sync. Sync may have been reset from another device." });
}

export const folderInfo = async (path?: string | null): Promise<FolderInfo | null> => (await SyncNative?.folderInfo(path ?? doc.folder ?? null)) ?? null;

function pointAt(path: string) {
  doc.folder = path;
  save();
  publishUi();
}

export const setSyncFolder = (path: string) => void (doc.enabled || pointAt(path));

export async function chooseSyncFolder(): Promise<string | null> {
  const picked = (await SyncNative?.chooseFolder(doc.folder)) ?? null;
  if (picked) setSyncFolder(picked);
  return picked;
}

export function moveSyncFolder(to: string): Promise<FolderMoveResult> {
  const native = SyncNative, from = doc.folder;
  if (!native || !doc.enabled || !from || stopping || moveRun) return Promise.resolve({ error: "busy" });
  if (useSync.getState().status === "locked") return Promise.resolve({ error: "locked" });
  clearTimeout(timer);
  return (moveRun = movingTo(native, from, to).finally(() => ((moveRun = null), scheduleSync(0))));
}

async function movingTo(native: NonNullable<typeof SyncNative>, from: string, to: string): Promise<FolderMoveResult> {
  while (cycle) await cycle.catch(() => {});
  const result = await moveChain(native, from, to, folderScopes(doc)).catch((error: unknown): FolderMoveResult => ({ error: "failed", message: errorText(error) }));
  if ("ok" in result && result.ok !== "same") pointAt(to);
  return noteFolderMove(result);
}

function begin(folder: string, deviceId: string, joining: boolean) {
  doc = { ...emptyDoc(), types: doc.types, enabled: true, folder, deviceId, setupAt: Date.now(), joining };
  startOver();
  publishUi({ status: "starting", error: null });
  scheduleSync(0);
}

export async function turnOnSync(folder: string, how?: TurnOnFolder): Promise<{ ok: true } | { error: string }> {
  const native = SyncNative;
  if (!native) return { error: "Sync isn’t available in this build." };
  await moveSettled();
  const deviceId = native.newDeviceId();
  try {
    if (!(await native.createPhrase(deviceId))) return { error: `Couldn’t save the sync key in ${PLATFORM_TERMS.secretStore}.` };
    await native.createChain(folder);
  } catch (error) {
    await native.forget(deviceId);
    return { error: `Couldn’t use that folder: ${errorText(error)}` };
  }
  begin(folder, deviceId, false);
  noteTurnOn(how);
  return { ok: true };
}

export async function enterRecoveryPhrase(folder: string, phrase: Secret<"syncPhrase">): Promise<PhraseResult | { error: "unavailable" }> {
  const native = SyncNative;
  if (!native) return { error: "unavailable" };
  await moveSettled();
  if (doc.enabled && doc.deviceId && useSync.getState().status === "locked") {
    const result = await native.enterPhrase(doc.deviceId, reveal(phrase), doc.folder ?? folder);
    if ("ok" in result) {
      await loadSavedState();
      publishUi({ status: "starting", error: null });
      scheduleSync(0);
    }
    return result;
  }
  const deviceId = native.newDeviceId();
  const result = await native.enterPhrase(deviceId, reveal(phrase), folder);
  if ("ok" in result) begin(folder, deviceId, true);
  return result;
}

export async function stopSync({ deleteData = false } = {}) {
  const native = SyncNative, consent = consentToken(), shown = doc.folder;
  await moveSettled();
  if (!native || !doc.enabled || stopping) return;
  stopping = true;
  await retire(native, deleteData ? [...new Set([doc.folder, shown])] : [], consent).finally(() => (stopping = false));
}

async function retire(native: NonNullable<typeof SyncNative>, deleteIn: (string | null)[], consent: ConsentToken | null) {
  clearTimeout(timer);
  const reportFailure = (error: unknown) => warnFor(consent, "[sync] the last cycle before stopping failed", error);
  while (cycle) await cycle.catch(reportFailure);
  if (useSync.getState().status !== "locked") await runCycle({ retiring: true }).catch(reportFailure);
  clearTimeout(timer);
  const folder = doc.folder;
  for (const target of deleteIn) {
    if (target) await native.deleteChain(target).catch((error: unknown) => warnFor(consent, "[sync] deleting sync data failed", error));
  }
  if (doc.deviceId) await native.forget(doc.deviceId);
  doc = { ...emptyDoc(), folder, types: doc.types };
  forgetScopeAdapters();
  startOver();
  publishUi({ status: "off", error: null });
}

const docChanged = () => void (save(), publishUi(), scheduleSync(0));

export function setTypeSynced(type: DataType, enabled: boolean) {
  doc.types = { ...doc.types, [type]: enabled };
  docChanged();
}

export function setProfileSynced(profileId: string, enabled: boolean) {
  const link = doc.profiles[profileId];
  if (!link) return;
  const { retire: _retire, ...kept } = link;
  doc.profiles[profileId] = enabled ? { ...kept, enabled } : { ...link, enabled, retire: true };
  docChanged();
}

export function setOpenTabsSynced(profileId: string, on: boolean) {
  markOpenTabsSynced(doc, profileId, on);
  docChanged();
}

export function sendTargets(profileId: string): SendTarget[] {
  return useSync.getState().status === "locked" ? [] : sendTargetsIn(doc, profileId);
}

export function sendTab(tabId: string, deviceId: string): boolean {
  if (useSync.getState().status === "locked" || !queueSend(doc, tabId, deviceId)) return false;
  save();
  scheduleSync(0);
  return true;
}

export const appScopeRecords = () => doc.scopes[APP_SCOPE]?.records ?? {};

export function addRemoteProfile(syncId: string): string | null {
  if (!remoteProfileRecord(doc, syncId) || linkedProfileId(doc, syncId)) return null;
  const { adds, sharesWith, waitingFor } = sharedDataChain(doc, syncId);
  if (waitingFor) return null;
  let shareWith = sharesWith;
  for (const add of adds.reverse()) shareWith = addLinkedProfile(doc, add, remoteProfileRecord(doc, add)!, shareWith);
  docChanged();
  return shareWith;
}

export const removeRemoteProfile = (syncId: string): boolean => markRemoved(doc, syncId) && (docChanged(), true);
export const removeSyncedDevice = (id: string): boolean => markDeviceRemoved(doc, id) && (docChanged(), true);

export function startSync() {
  if (!SyncNative) return;
  load();
  publishUi({ status: doc.enabled ? "starting" : "off" });
  watchExtensions();
  if (doc.enabled && doc.deviceId) {
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
    watchExtensions();
    scheduleSync();
  });
  useBrowser.subscribeTo(["tabs", "bookmarks", "settings", "profiles", "profileOrder", "groups"], (s, prev) => {
    if (!doc.enabled) return;
    const closed = !isQuitting() && recordOpenTabCloses(doc, openTabsClosed(s, prev));
    if (closed && !cycle) save();
    if (closed || (!cycle && (s.bookmarks !== prev.bookmarks || s.settings !== prev.settings || s.profiles !== prev.profiles || s.profileOrder !== prev.profileOrder || s.groups !== prev.groups))) scheduleSync();
  });
  if (__DEV__)
    exposeDevSync({ useSync, syncNow, turnOnSync, enterRecoveryPhrase: (folder: string, text: string) => enterRecoveryPhrase(folder, asSecret("syncPhrase", text)), stopSync, setTypeSynced, setProfileSynced, setOpenTabsSynced, addRemoteProfile, removeRemoteProfile, removeSyncedDevice, setSyncFolder, moveSyncFolder, folderInfo, doc: () => doc, native: SyncNative });
}
