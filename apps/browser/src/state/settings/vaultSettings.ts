import { isStringList } from "../../lib/decode";
import { flag, shaped, STRING_LIST, SYNCED, text } from "./settingSpecs";

export const VAULT_LOCK_MINUTES = [5, 15, 30, 60, 0] as const;
export const VAULT_KEEP_GENERATED_DAYS = [1, 7, 30, -1, 0] as const;

export const VAULT_SETTING_SPECS = {
  vaultSuggestOnFocus: flag(true, SYNCED),
  vaultSuggestLogins: flag(true, SYNCED),
  vaultSuggestCodes: flag(true, SYNCED),
  vaultSuggestUsernames: flag(true, SYNCED),
  vaultSuggestNewPasswords: flag(true, SYNCED),
  vaultSuggestGenerated: flag(true, SYNCED),
  vaultMenuGlass: flag(true, SYNCED),
  vaultMenuSelectionReturns: flag(false, SYNCED),
  vaultAskBeforeFilling: flag(true),
  vaultSaveOffer: flag(true, SYNCED),
  vaultAutoSave: flag(true, SYNCED),
  vaultContextGenerate: flag(false, SYNCED),
  vaultSaveTarget: text(""),
  vaultPasskeySource: text("ask"),
  vaultPasskeyExtensions: shaped<string[]>([], isStringList, STRING_LIST),
  vaultIdleLockMinutes: shaped<number>(30, (v) => (VAULT_LOCK_MINUTES as readonly unknown[]).includes(v), { type: "number", enum: VAULT_LOCK_MINUTES }),
  vaultTouchID: flag(true),
  vaultICloudSync: flag(true),
  vaultLockOnQuit: flag(true),
  vaultLockOnScreenLock: flag(true),
  vaultKeepGenerated: shaped<number>(7, (v) => (VAULT_KEEP_GENERATED_DAYS as readonly unknown[]).includes(v), { type: "number", enum: VAULT_KEEP_GENERATED_DAYS }),
};
