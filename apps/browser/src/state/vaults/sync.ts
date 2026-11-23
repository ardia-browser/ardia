import { nativeConsent } from "../telemetry/nativeConsent";
import { create } from "zustand";
import { ago } from "../live/meetings";
import {
  deleteVaultBackup,
  onVaultBackupChanged,
  restoreVaultBackup,
  resumeVaultBackup,
  updateFromVaultBackup,
  syncVaults,
  vaultBackupStatus,
  vaultSyncStatus,
  type VaultBackupStatus,
  type VaultRestoreResult,
  type VaultSyncResult,
} from "../../platform/vaults";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { useBrowser } from "../browser/store";
import { confirm } from "../app/system";
import { updateSettings } from "../settings/actions";
import { noteVaultBackupChange, noteVaultRestore, noteVaultUpdateFromBackup } from "../telemetry/vaultCounts";
import { restoredLine, updatedLine } from "./backupCopy";
import { unlockProvider } from "./actions";
import { currentVaultProviders, loadAllVaultItems } from "./store";

type VaultSyncPhase = "idle" | "syncing" | "synced" | "failed";

type VaultSyncState = {
  phase: VaultSyncPhase;
  syncedAt: number | null;
  iCloud: boolean;
  failed: string[];
  backup: VaultBackupStatus | null;
  restoring: boolean;
  restoreNote: string | null;
};

export const useVaultSync = create<VaultSyncState>()(() => ({
  phase: "idle",
  syncedAt: null,
  iCloud: false,
  failed: [],
  backup: null,
  restoring: false,
  restoreNote: null,
}));

const SYNCED_SHOWN_MS = 2000;

export const syncedLine = (syncedAt: number | null, now: number) => (syncedAt ? `Synced ${ago(syncedAt, now)}` : undefined);

let resetTimer: ReturnType<typeof setTimeout> | null = null;

function settle(result: VaultSyncResult | null) {
  if (resetTimer) clearTimeout(resetTimer);
  const phase: VaultSyncPhase = result?.ok ? "synced" : "failed";
  useVaultSync.setState((s) => ({
    phase,
    syncedAt: result?.syncedAt ?? s.syncedAt,
    iCloud: result?.iCloud ?? s.iCloud,
    failed: result?.failed ?? [],
    backup: result?.backup ? { ...result.backup, restorable: s.backup?.restorable } : s.backup,
  }));
  if (phase === "failed") return;
  resetTimer = setTimeout(() => {
    resetTimer = null;
    useVaultSync.setState((s) => (s.phase === "syncing" ? s : { phase: "idle" }));
  }, SYNCED_SHOWN_MS);
}

export async function refreshVaultSyncStatus() {
  const status = await vaultSyncStatus().catch(() => null);
  if (status) useVaultSync.setState({ syncedAt: status.syncedAt, iCloud: status.iCloud });
}

const backupProfiles = () => {
  const s = useBrowser.getState();
  return [...new Set(s.profileOrder.filter((id) => !isIncognitoProfile(id)).map((id) => engineProfile(s, id)))];
};

let backupWatchers = 0;

let backupRead: Promise<void> | null = null;
let backupReadAgain = false;

function refreshVaultBackup(): Promise<void> {
  if (backupRead) {
    backupReadAgain = true;
    return backupRead;
  }
  backupRead = vaultBackupStatus(backupProfiles())
    .catch(() => null)
    .then((backup) => {
      if (backup) useVaultSync.setState({ backup });
    })
    .finally(() => {
      backupRead = null;
      if (backupReadAgain) {
        backupReadAgain = false;
        void refreshVaultBackup();
      }
    });
  return backupRead;
}

export function watchVaultBackup() {
  backupWatchers++;
  void refreshVaultBackup();
  return () => {
    backupWatchers--;
    if (!backupWatchers && !useVaultSync.getState().restoring) useVaultSync.setState({ restoreNote: null });
  };
}

export function startVaultBackupWatch() {
  return onVaultBackupChanged((change) => {
    noteVaultBackupChange(change, nativeConsent(change));
    const { outcome: _, ...status } = change;
    useVaultSync.setState((s) => ({ backup: { ...status, restorable: s.backup?.restorable, updatable: s.backup?.updatable } }));
    if (backupWatchers > 0) void refreshVaultBackup();
  });
}

async function restoreWith(
  run: (profiles: string[]) => Promise<VaultRestoreResult>,
  note: (result: VaultRestoreResult) => void,
  line: (restored: number, failed: number) => string,
): Promise<VaultRestoreResult | null> {
  if (useVaultSync.getState().restoring) return null;
  useVaultSync.setState({ restoring: true, restoreNote: null });
  const result = await run(backupProfiles()).catch(() => null);
  if (result) note(result);
  const restoreNote = !result ? line(0, 1) : result.declined ? null : line(result.restored, result.failed);
  useVaultSync.setState({ restoring: false, restoreNote });
  await refreshVaultBackup();
  return result;
}

export async function updateFromICloud() {
  await restoreWith(updateFromVaultBackup, noteVaultUpdateFromBackup, updatedLine);
}

export async function deleteICloudBackup() {
  const { confirmed } = await confirm({
    title: "Delete Passwords from iCloud?",
    message: "Your other Macs will stop syncing passwords.",
    confirmTitle: "Delete",
    destructive: true,
    cancelIsDefault: true,
  });
  if (!confirmed) return;
  const result = await deleteVaultBackup().catch(() => null);
  if (result?.deleted) updateSettings({ vaultICloudSync: false });
  await refreshVaultBackup();
}

export async function resumeICloudBackup() {
  await resumeVaultBackup().catch(() => null);
  await refreshVaultBackup();
}

export function setICloudSync(on: boolean) {
  updateSettings({ vaultICloudSync: on });
  if (on) void resumeVaultBackup().then(refreshVaultBackup, () => undefined);
}

export async function restoreFromICloud() {
  const result = await restoreWith(restoreVaultBackup, noteVaultRestore, restoredLine);
  if (result?.restored) await loadAllVaultItems(true);
}

export async function syncVaultsNow(): Promise<VaultSyncResult | null> {
  if (useVaultSync.getState().phase === "syncing") return null;
  useVaultSync.setState({ phase: "syncing", failed: [] });
  const providers = currentVaultProviders();
  if (!providers.some((p) => p.state === "unlocked")) {
    const locked = providers.find((p) => p.state === "locked" && p.touchUnlock);
    if (locked) await unlockProvider(locked.id, null);
  }
  const result = await syncVaults().catch(() => null);
  await loadAllVaultItems(true);
  settle(result);
  return result;
}
