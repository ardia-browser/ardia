import { asSecret, type Secret } from "@ardia/core";
import { create } from "zustand";
import * as engine from "../../browser/src/state/sync/engine";
import type { DataType, SendTarget, SyncUi } from "../../browser/src/state/sync/syncDoc";
import type { FolderInfo, PhraseResult } from "../../browser/src/platform/sync";
import { pickSyncFolder, type FolderMoveResult, type TurnOnFolder } from "../../browser/src/state/sync/folderMove";
import { SyncNative } from "../../browser/src/platform/sync";
import { ardiaHost, type ArdiaHost } from "./host";
import { syncIdle, syncNowIfIdle, syncNowThrough } from "./syncForward";
import { keyringMessage, presentSyncState, SYNC_KEY_NOT_SAVED } from "./syncKeyStore";
import { consentToken } from "../../browser/src/state/telemetry/client";
import { noteSyncOpenFailures } from "../../browser/src/state/telemetry/syncFileCounts";
import { warnFor } from "../../browser/src/state/telemetry/logs";
import { keyringObserver, noteSyncKeyStore } from "./syncKeyringCounts";
import type { ConsentToken } from "../../browser/src/state/telemetry/choice";
import {
  claimSyncAuthority,
  configureHeldLogins,
  configureOpenFailureCount,
  createHeldLogins,
  HeldLoginsResetError,
  enterPhraseBegins,
  heldLoginsStatus,
  whileResettingHeldLogins,
  KEYRING_RETRY_MS,
  keyringResumer,
  loadSyncCore,
  watchLockedSync,
  loadSyncDeviceName,
  refreshSyncDocuments,
  releaseSyncAuthority,
  syncDeviceName,
  syncKeyStoreStatus,
  type SyncKeyStoreStatus,
} from "./hostSync.ts";
import { deleteDocument, readDocument, refreshDocument, saveDocument } from "./shims/shellBase";
import { useBrowser } from "../../browser/src/state/browser/store";
import { engineProfile } from "../../browser/src/state/browser/model";
import {
  INTERACTIVE_CALL_TIMEOUT_MS,
  SYNC_CHANNEL,
  startSyncAuthority,
  type LocksLike,
  type RemoteMethod,
  type SyncAuthority,
  type SyncRemote,
} from "./syncAuthority.ts";

const KEYCHAIN_ERROR = "Couldn’t save the sync key in your Keychain.";

configureOpenFailureCount(consentToken, noteSyncOpenFailures);

export const useSync = create<SyncUi>()(() => ({ ...engine.useSync.getState(), status: SyncNative ? "starting" : "unavailable" }));

let authority: SyncAuthority | null = null;
let keyStore: SyncKeyStoreStatus | null = null;

function readKeyStore(host: ArdiaHost, consent: ConsentToken | null): Promise<SyncKeyStoreStatus> {
  return syncKeyStoreStatus(host).then((status) => {
    noteSyncKeyStore(status, consent);
    return status;
  });
}

let heldLogins: ReturnType<typeof createHeldLogins> | null = null;

function adoptHeldLogins() {
  heldLogins = createHeldLogins({
    read: readDocument,
    save: saveDocument,
    remove: deleteDocument,
    seal: async (text) => SyncNative?.sealLocal(text),
    open: async (sealed) => SyncNative?.openLocal(sealed),
  });
  configureHeldLogins(heldLogins);
}

let watchingProfiles = false;
let keyringWatch: (() => void) | null = null;

function stopKeyringWatch() {
  keyringWatch?.();
  keyringWatch = null;
}

function resumeWhenKeyringOpens(host: ArdiaHost) {
  stopKeyringWatch();
  const observed = keyringObserver(() => syncKeyStoreStatus(host), consentToken);
  const tick = keyringResumer({
    locked: () => {
      const state = engine.useSync.getState();
      return !!authority?.isAuthority() && state.enabled && state.status === "locked";
    },
    status: observed.status,
    seen: (status) => {
      observed.note(status);
      const shown = keyringMessage(keyStore, false);
      keyStore = status;
      if (keyringMessage(status, false) !== shown) engine.useSync.setState({});
    },
    resume: () => engine.enterRecoveryPhrase(engine.useSync.getState().folder ?? "", asSecret("syncPhrase", "")),
  });
  keyringWatch = watchLockedSync(engine.useSync, tick, KEYRING_RETRY_MS);
}

function dropDeletedProfiles() {
  if (watchingProfiles) return;
  watchingProfiles = true;
  let last = useBrowser.getState().profiles;
  let seen = new Set(Object.keys(last).map((id) => engineProfile({ profiles: last }, id)));
  useBrowser.subscribe((state) => {
    if (state.profiles === last) return;
    last = state.profiles;
    const live = new Set(Object.keys(last).map((id) => engineProfile({ profiles: last }, id)));
    if (live.size) {
      const consent = consentToken();
      void heldLogins?.dropProfiles([...seen].filter((profile) => !live.has(profile))).catch((error: unknown) =>
        warnFor(consent, "[ardia linux] sync", error instanceof Error ? error.message : error),
      );
    }
    seen = live;
  });
}

function dropHeldLogins() {
  heldLogins = null;
  configureHeldLogins(null);
}

function remoteFor(host: ArdiaHost): SyncRemote {
  return {
    syncNow: () => engine.syncNow(),
    syncIdle: () => syncIdle(engine.syncNow),
    syncNowIfIdle: () => syncNowIfIdle(engine.syncNow),
    turnOnSync: async (folder: string, how?: TurnOnFolder) => {
      const consent = consentToken();
      let result: Awaited<ReturnType<typeof engine.turnOnSync>>;
      try {
        result = await whileResettingHeldLogins(
          () => engine.turnOnSync(folder, how),
          (result) => !("error" in result),
          () => engine.stopSync({ deleteData: true }),
        );
      } catch (error) {
        if (error instanceof HeldLoginsResetError) return { error: error.message };
        throw error;
      }
      if ("error" in result && result.error === KEYCHAIN_ERROR) {
        keyStore = await readKeyStore(host, consent).catch(() => keyStore);
        return { error: keyringMessage(keyStore, true) ?? SYNC_KEY_NOT_SAVED };
      }
      return result;
    },
    enterRecoveryPhrase: (folder: string, phrase: Secret<"syncPhrase">) => {
      const begins = enterPhraseBegins(engine.useSync.getState());
      return whileResettingHeldLogins(
        () => engine.enterRecoveryPhrase(folder, phrase),
        (result) => begins && "ok" in result,
        () => engine.stopSync(),
      ).catch((error: unknown) => {
        if (error instanceof HeldLoginsResetError) return { error: "unavailable" as const };
        throw error;
      });
    },
    stopSync: (options?: { deleteData?: boolean }) => engine.stopSync(options),
    setTypeSynced: (type: DataType, enabled: boolean) => engine.setTypeSynced(type, enabled),
    setProfileSynced: (profileId: string, enabled: boolean) => engine.setProfileSynced(profileId, enabled),
    setOpenTabsSynced: (profileId: string, enabled: boolean) => engine.setOpenTabsSynced(profileId, enabled),
    addRemoteProfile: (syncId: string) => engine.addRemoteProfile(syncId),
    removeRemoteProfile: (syncId: string) => engine.removeRemoteProfile(syncId),
    removeSyncedDevice: (deviceId: string) => engine.removeSyncedDevice(deviceId),
    adoptProfileTheme: (profileId: string) => engine.adoptProfileTheme(profileId),
    useFolder: (path: string) => engine.setSyncFolder(path),
    moveFolder: (path: string) => engine.moveSyncFolder(path),
    sendTargets: (profileIds: string[]) => Object.fromEntries(profileIds.map((profileId) => [profileId, engine.sendTargets(profileId)])),
    sendTab: (tabId: string, deviceId: string) => engine.sendTab(tabId, deviceId),
  };
}

async function becomeAuthority(host: ArdiaHost) {
  const consent = consentToken();
  try {
    await refreshSyncDocuments({ refresh: refreshDocument, remove: deleteDocument });
  } catch (error) {
    useSync.setState({ status: "stalled", error: "Ardia couldn’t read this device’s sync files, so sync is paused to keep them." });
    throw error;
  }
  await loadSyncDeviceName(host);
  keyStore = await readKeyStore(host, consent).catch(() => null);
  adoptHeldLogins();
  dropDeletedProfiles();
  engine.startSync();
  resumeWhenKeyringOpens(host);
  return { store: engine.useSync, remote: remoteFor(host) };
}

export function startLinuxSync(options: { host?: ArdiaHost; candidate: boolean; locks?: LocksLike; channel?: () => BroadcastChannel | null }) {
  const host = options.host ?? ardiaHost;
  if (authority || !SyncNative || !host) return authority;
  void loadSyncCore(host);
  const channel = (options.channel ?? (() => (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(SYNC_CHANNEL))))();
  const id = `${host.bootstrap.windowId}:${Math.random().toString(36).slice(2)}`;
  const started = startSyncAuthority<SyncUi>({
    id,
    candidate: options.candidate && !host.bootstrap.privateWindow,
    locks: options.locks,
    channel,
    mirror: useSync,
    claim: async () => {
      const claim = await claimSyncAuthority(host);
      if (!claim.granted) dropHeldLogins();
      else if (!heldLogins && authority?.isAuthority()) adoptHeldLogins();
      return claim;
    },
    onRole: (role) => {
      if (role !== "authority") {
        dropHeldLogins();
        stopKeyringWatch();
      }
    },
    release: () => releaseSyncAuthority(host),
    become: () => becomeAuthority(host),
    present: (state) => presentSyncState(state, keyStore),
  });
  authority = started;
  const stopTargets = useSync.subscribe(refreshSendTargets);
  if (typeof addEventListener === "function")
    addEventListener("pagehide", () => {
      stopKeyringWatch();
      stopTargets();
      started.stop();
    }, { once: true });
  return started;
}

export const linuxSyncHooks = {
  state: () => useSync.getState(),
  role: () => authority?.role() ?? "unavailable",
  heldLogins: () => heldLoginsStatus(),
  turnOnSync: (folder: string) => turnOnSync(folder),
  enterRecoveryPhrase: (folder: string, text: string) => enterRecoveryPhrase(folder, asSecret("syncPhrase", text)),
  stopSync: (options?: { deleteData?: boolean }) => stopSync(options),
  syncNow: () => syncNow(),
  setTypeSynced: (type: DataType, enabled: boolean) => setTypeSynced(type, enabled),
};

export const startSync = () => void startLinuxSync({ candidate: true, locks: typeof navigator === "undefined" ? undefined : navigator.locks });

const leading = () => !!authority?.isAuthority();

function forward<T>(method: RemoteMethod, args: unknown[], timeoutMs?: number): Promise<T> {
  if (!authority) return Promise.reject(new Error("Sync isn’t running in this window."));
  return authority.call(method, args, timeoutMs) as Promise<T>;
}

const quietly = (promise: Promise<unknown>) => {
  const consent = consentToken();
  void promise.catch((error: unknown) => warnFor(consent, "[ardia linux] sync", error));
};

export const currentSyncFolder = () => useSync.getState().folder;
export const deviceName = () => syncDeviceName();
export const appScopeRecords = () => (leading() ? engine.appScopeRecords() : {});

export async function folderInfo(path?: string | null): Promise<FolderInfo | null> {
  return (await SyncNative?.folderInfo(path ?? useSync.getState().folder ?? null)) ?? null;
}

export async function setSyncFolder(path: string) {
  if (leading()) engine.setSyncFolder(path);
  else await forward("useFolder", [path]);
}

export async function chooseSyncFolder(): Promise<string | null> {
  const picked = await pickSyncFolder(useSync.getState().folder);
  if (picked) await setSyncFolder(picked);
  return picked;
}

export async function moveSyncFolder(path: string): Promise<FolderMoveResult> {
  if (leading()) return engine.moveSyncFolder(path);
  try {
    return await forward<FolderMoveResult>("moveFolder", [path], INTERACTIVE_CALL_TIMEOUT_MS);
  } catch (error) {
    return { error: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

const WRITES_CLOSED: readonly string[] = ["starting", "locked", "off", "unavailable"];

export const syncWritesOpen = () => {
  if (leading()) return engine.syncWritesOpen();
  const s = useSync.getState();
  return s.enabled && !WRITES_CLOSED.includes(s.status);
};

export async function syncNow(stillWanted: () => void = () => {}): Promise<boolean> {
  if (leading()) return engine.syncNow(stillWanted);
  return syncNowThrough(
    () => forward("syncIdle", [], INTERACTIVE_CALL_TIMEOUT_MS),
    () => forward("syncNowIfIdle", [], INTERACTIVE_CALL_TIMEOUT_MS),
    stillWanted,
  );
}

export async function turnOnSync(folder: string, how?: TurnOnFolder): Promise<{ ok: true } | { error: string }> {
  if (!SyncNative) return { error: "Sync isn’t available in this build." };
  try {
    return await forward("turnOnSync", [folder, how], INTERACTIVE_CALL_TIMEOUT_MS);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function enterRecoveryPhrase(folder: string, phrase: Secret<"syncPhrase">): Promise<PhraseResult | { error: "unavailable" }> {
  if (!SyncNative) return { error: "unavailable" };
  const consent = consentToken();
  try {
    return await forward("enterRecoveryPhrase", [folder, phrase], INTERACTIVE_CALL_TIMEOUT_MS);
  } catch (error) {
    warnFor(consent, "[ardia linux] sync", error instanceof Error ? error.message : error);
    return { error: "unavailable" };
  }
}

export async function stopSync(options: { deleteData?: boolean } = {}) {
  await forward("stopSync", [options], INTERACTIVE_CALL_TIMEOUT_MS);
}

export function setTypeSynced(type: DataType, enabled: boolean) {
  quietly(forward("setTypeSynced", [type, enabled]));
}

export function setProfileSynced(profileId: string, enabled: boolean) {
  quietly(forward("setProfileSynced", [profileId, enabled]));
}

export function setOpenTabsSynced(profileId: string, enabled: boolean) {
  quietly(forward("setOpenTabsSynced", [profileId, enabled]));
}

export function addRemoteProfile(syncId: string): string | null {
  if (leading()) return engine.addRemoteProfile(syncId);
  quietly(forward("addRemoteProfile", [syncId]));
  return null;
}

export function removeRemoteProfile(syncId: string): boolean {
  if (leading()) return engine.removeRemoteProfile(syncId);
  quietly(forward("removeRemoteProfile", [syncId]));
  return true;
}

export function removeSyncedDevice(deviceId: string): boolean {
  if (leading()) return engine.removeSyncedDevice(deviceId);
  quietly(forward("removeSyncedDevice", [deviceId]));
  return true;
}

let relayedTargets: Record<string, SendTarget[]> = {};

function refreshSendTargets() {
  if (!authority || leading()) return;
  forward<Record<string, SendTarget[]>>("sendTargets", [Object.keys(useBrowser.getState().profiles)]).then(
    (targets) => { relayedTargets = targets; },
    () => { relayedTargets = {}; },
  );
}

export const onTabsReceived = engine.onTabsReceived;
export const takeSnapshotWrites = engine.takeSnapshotWrites;
export const takeOpenTabSyncCounts = engine.takeOpenTabSyncCounts;
export { whenSyncCore } from "./hostSync.ts";

export function sendTargets(profileId: string): SendTarget[] {
  return leading() ? engine.sendTargets(profileId) : relayedTargets[profileId] ?? [];
}

export function sendTab(tabId: string, deviceId: string): boolean {
  if (leading()) return engine.sendTab(tabId, deviceId);
  const profileId = useBrowser.getState().tabs[tabId]?.profileId;
  if (!profileId || !sendTargets(profileId).some((target) => target.id === deviceId)) return false;
  quietly(forward("sendTab", [tabId, deviceId]));
  return true;
}

export function adoptProfileTheme(profileId: string) {
  if (leading()) return engine.adoptProfileTheme(profileId);
  quietly(forward("adoptProfileTheme", [profileId]));
}
