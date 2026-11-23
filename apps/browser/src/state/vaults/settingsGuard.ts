import { consentToken } from "../telemetry/choice";
import { unlockPasswords } from "../../platform/passwords";
import { useBrowser } from "../browser/store";
import type { Settings } from "../settings/settings";
import { noteVaultGuard } from "../telemetry/vaultCounts";

export const GUARDED_VAULT_SETTINGS = ["vaultAskBeforeFilling", "vaultLockOnQuit", "vaultLockOnScreenLock", "vaultIdleLockMinutes"] as const;

type GuardedVaultSetting = (typeof GUARDED_VAULT_SETTINGS)[number];

type Guarded = Pick<Settings, GuardedVaultSetting>;

const lockWait = (minutes: number) => (minutes <= 0 ? Infinity : minutes);

export function weakensVaultSecurity(before: Guarded, patch: Partial<Guarded>): boolean {
  if (patch.vaultAskBeforeFilling === false && before.vaultAskBeforeFilling) return true;
  if (patch.vaultLockOnQuit === false && before.vaultLockOnQuit) return true;
  if (patch.vaultLockOnScreenLock === false && before.vaultLockOnScreenLock) return true;
  return patch.vaultIdleLockMinutes !== undefined && lockWait(patch.vaultIdleLockMinutes) > lockWait(before.vaultIdleLockMinutes);
}

let asking: Promise<boolean> | null = null;

export const ownerConfirms = () => (asking ??= unlockPasswords("").catch(() => false).finally(() => (asking = null)));

export async function confirmLeavingArdia(): Promise<boolean> {
  const consent = consentToken();
  const confirmed = await ownerConfirms();
  noteVaultGuard(confirmed, consent);
  return confirmed;
}

export async function changeGuardedVaultSetting(patch: Partial<Guarded>): Promise<boolean> {
  const consent = consentToken();
  if (weakensVaultSecurity(useBrowser.getState().settings, patch)) {
    const confirmed = await ownerConfirms();
    noteVaultGuard(confirmed, consent);
    if (!confirmed) return false;
  }
  useBrowser.getState().updateSettings(patch);
  return true;
}
