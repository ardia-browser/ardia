import { create } from "zustand";
import { readDocument, saveDocument } from "../../platform/documents";
import { parseSaved, unchanged, versionedJson, type Migrations } from "../../lib/savedDocument";
import { orWarn } from "../../lib/fallback";

export const VAULT_PREFS = "agent-vault.json";
const PREFS_VERSION = 1;
const PREFS_MIGRATIONS: Migrations = { 0: unchanged };

export type VaultPrefs = { logShowsReasons: boolean; keepsCodes: boolean };

const DEFAULTS: VaultPrefs = { logShowsReasons: false, keepsCodes: false };

function readPrefs(): VaultPrefs {
  try {
    const saved = parseSaved(readDocument(VAULT_PREFS), PREFS_VERSION, PREFS_MIGRATIONS) as Partial<VaultPrefs> | null;
    return { logShowsReasons: saved?.logShowsReasons === true, keepsCodes: saved?.keepsCodes === true };
  } catch {
    return DEFAULTS;
  }
}

export const useVaultPrefs = create<VaultPrefs & { read: boolean }>()(() => ({ ...DEFAULTS, read: false }));

export function vaultPrefs(): VaultPrefs {
  if (!useVaultPrefs.getState().read) useVaultPrefs.setState({ ...readPrefs(), read: true });
  const { logShowsReasons, keepsCodes } = useVaultPrefs.getState();
  return { logShowsReasons, keepsCodes };
}

function setPrefs(change: Partial<VaultPrefs>) {
  const next = { ...vaultPrefs(), ...change };
  useVaultPrefs.setState(next);
  void saveDocument(VAULT_PREFS, versionedJson(next, PREFS_VERSION)).catch(orWarn(undefined));
}

export const setLogShowsReasons = (on: boolean) => setPrefs({ logShowsReasons: on });
export const setKeepsCodes = (on: boolean) => setPrefs({ keepsCodes: on });
