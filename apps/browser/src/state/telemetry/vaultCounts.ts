import { takeVaultKeychainCounts, type VaultBackupChange, type VaultRestoreResult } from "../../platform/vaults";
import { consentToken, type ConsentToken } from "./consentPeriod";
import { consentOrNow, countFor } from "./countFor";

const SLOW_ROWS_MS = 50;

const CREDENTIAL_NAMES = ["1password", "bitwarden", "protonpass", "other"] as const;
type CredentialName = (typeof CREDENTIAL_NAMES)[number];
const CREDENTIAL_KINDS = { calls: "calls", callFailures: "call_failures", verbRefusals: "verb_refusals" } as const;
type CredentialField = `credential_${"provider_connected" | (typeof CREDENTIAL_KINDS)[keyof typeof CREDENTIAL_KINDS]}_${CredentialName}`;

const credentialFields = () =>
  Object.fromEntries(
    (["provider_connected", ...Object.values(CREDENTIAL_KINDS)] as const).flatMap((kind) => CREDENTIAL_NAMES.map((name) => [`credential_${kind}_${name}`, 0])),
  ) as Record<CredentialField, number>;

export const credentialCountName = (provider: string): CredentialName =>
  CREDENTIAL_NAMES.find((name) => name === provider && name !== "other") ?? "other";

const empty = () => ({
  vault_fills: 0,
  vault_fills_refused_for_site: 0,
  vault_fills_offline: 0,
  vault_fills_failed: 0,
  vault_menu_rows_built: 0,
  vault_menu_rows_slow: 0,
  vault_menu_opens_from_icon: 0,
  vault_pick_rank_1: 0,
  vault_pick_rank_2: 0,
  vault_pick_rank_3_to_5: 0,
  vault_pick_rank_6_plus: 0,
  vault_pick_typed_rank_1: 0,
  vault_pick_typed_rank_2_plus: 0,
  vault_guard_confirmed: 0,
  vault_guard_declined: 0,
  vault_codes_set_up_context_menu: 0,
  vault_codes_set_up_clipboard: 0,
  vault_codes_set_up_image: 0,
  vault_codes_set_up_page: 0,
  vault_codes_set_up_import: 0,
  vault_codes_removed: 0,
  vault_codes_filled: 0,
  vault_codes_autofilled: 0,
  vault_codes_copied: 0,
  vault_code_reads_missed: 0,
  vault_backups: 0,
  vault_backup_failures: 0,
  vault_backup_key_waits: 0,
  vault_backup_deletes: 0,
  vault_updates_from_backup: 0,
  vault_restores: 0,
  vault_restores_declined: 0,
  vault_logins_restored: 0,
  vault_logins_restore_failed: 0,
  vault_logins_edited_manager: 0,
  vault_passwords_updated_from_offer: 0,
  vault_logins_created_settings: 0,
  vault_logins_created_with_code: 0,
  vault_logins_edited_ardia: 0,
  vault_codes_standalone_created: 0,
  vault_codes_standalone_imported: 0,
  vault_codes_standalone_deleted: 0,
  vault_codes_standalone_copied: 0,
  vault_codes_standalone_filled: 0,
  vault_passkeys_created: 0,
  vault_passkeys_used: 0,
  vault_passkeys_fallback: 0,
  vault_passkeys_refused: 0,
  vault_passkeys_failed: 0,
  vault_passkeys_deleted: 0,
  vault_passkeys_via_ardia: 0,
  vault_passkeys_via_chrome: 0,
  vault_passkeys_via_extension_proton: 0,
  vault_passkeys_via_extension_onepassword: 0,
  vault_passkeys_via_extension_bitwarden: 0,
  vault_passkeys_via_extension_dashlane: 0,
  vault_passkeys_via_extension_nordpass: 0,
  vault_passkeys_via_extension_keeper: 0,
  vault_passkeys_via_extension_lastpass: 0,
  vault_passkeys_via_extension_other: 0,
  vault_passkey_chooser_shown: 0,
  vault_sign_ins: 0,
  vault_sign_in_failures: 0,
  vault_sign_in_two_step: 0,
  vault_sign_ins_cancelled: 0,
  vault_logins_failed_after_navigation: 0,
  vault_unlocks_typed: 0,
  vault_unlock_failures: 0,
  vault_unlock_entries_expired: 0,
  vault_cli_checks: 0,
  vault_chrome_dropdowns_hidden: 0,
  vault_menu_yields_to_chrome: 0,
  vault_ardia_choices_recorded: 0,
  vault_keychain_reads: 0,
  vault_keychain_reads_from_memory: 0,
  vault_keychain_writes_skipped: 0,
  vault_login_keychain_calls: 0,
  vault_store_legacy_migrated: 0,
  vault_store_newer_format_kept: 0,
  vault_store_cloud_newer_format_kept: 0,
  vault_catalog_builds: 0,
  vault_catalog_builds_slow: 0,
  vault_store_unreadable_kept: 0,
  vault_store_key_read_failed: 0,
  vault_stale_work_dropped: 0,
  vault_store_resealed: 0,
  vault_store_set_aside: 0,
  vault_store_key_not_noted: 0,
  vault_stale_provider_states_ignored: 0,
  vault_menu_early_clicks_ignored: 0,
  ...credentialFields(),
});

let counts = empty();

type VaultCountField = keyof ReturnType<typeof empty>;

const bump = (field: VaultCountField, consent?: ConsentToken | null, by = 1) => countFor(consentOrNow(consent), () => void (counts[field] += by));

const fillField = (error: string | null | undefined): VaultCountField =>
  !error ? "vault_fills" : error === "originMismatch" || error === "insecure" ? "vault_fills_refused_for_site" : error === "offline" ? "vault_fills_offline" : "vault_fills_failed";

export const noteVaultFill = (error: string | null | undefined, consent?: ConsentToken | null) => bump(fillField(error), consent);

export function noteVaultMenuRowsBuilt(ms: number, consent?: ConsentToken | null) {
  bump("vault_menu_rows_built", consent);
  if (ms > SLOW_ROWS_MS) bump("vault_menu_rows_slow", consent);
}

export const noteVaultMenuOpenFromIcon = () => bump("vault_menu_opens_from_icon");

export function noteVaultLoginPicked(index: number, typed: boolean, consent?: ConsentToken | null) {
  if (index < 0) return;
  if (typed) return bump(index === 0 ? "vault_pick_typed_rank_1" : "vault_pick_typed_rank_2_plus", consent);
  bump(index === 0 ? "vault_pick_rank_1" : index === 1 ? "vault_pick_rank_2" : index < 5 ? "vault_pick_rank_3_to_5" : "vault_pick_rank_6_plus", consent);
}

export const noteVaultGuard = (confirmed: boolean, consent?: ConsentToken | null) => bump(confirmed ? "vault_guard_confirmed" : "vault_guard_declined", consent);

export const noteArdiaChoiceRecorded = (consent?: ConsentToken | null) => bump("vault_ardia_choices_recorded", consent);

const SETUP_FIELD = {
  contextMenu: "vault_codes_set_up_context_menu",
  clipboard: "vault_codes_set_up_clipboard",
  image: "vault_codes_set_up_image",
  page: "vault_codes_set_up_page",
  import: "vault_codes_set_up_import",
} as const;

export const noteVaultCodeSetUp = (method: keyof typeof SETUP_FIELD, count = 1, consent?: ConsentToken | null) => bump(SETUP_FIELD[method], consent, count);
export const noteVaultCodeRemoved = (consent?: ConsentToken | null) => bump("vault_codes_removed", consent);
export const noteVaultCodeFilled = (consent?: ConsentToken | null) => bump("vault_codes_filled", consent);
export const noteVaultCodeAutofill = (consent?: ConsentToken | null) => bump("vault_codes_autofilled", consent);
export const noteVaultCodeCopied = (consent?: ConsentToken | null) => bump("vault_codes_copied", consent);
export const noteVaultCodeReadMissed = (consent?: ConsentToken | null) => bump("vault_code_reads_missed", consent);
export const noteVaultLoginEdited = (consent?: ConsentToken | null) => bump("vault_logins_edited_manager", consent);
export function noteLoginCreatedInSettings(withCode: boolean, consent?: ConsentToken | null) {
  bump("vault_logins_created_settings", consent);
  if (withCode) bump("vault_logins_created_with_code", consent);
}
export const noteArdiaLoginEdited = (consent?: ConsentToken | null) => bump("vault_logins_edited_ardia", consent);
export const noteStandaloneCodeCreated = (consent?: ConsentToken | null) => bump("vault_codes_standalone_created", consent);
export const noteStandaloneCodesImported = (count: number, consent?: ConsentToken | null) => bump("vault_codes_standalone_imported", consent, count);
export const noteStandaloneCodeDeleted = (consent?: ConsentToken | null) => bump("vault_codes_standalone_deleted", consent);
export const noteStandaloneCodeCopied = (consent?: ConsentToken | null) => bump("vault_codes_standalone_copied", consent);
export const noteStandaloneCodeFilled = (consent?: ConsentToken | null) => bump("vault_codes_standalone_filled", consent);
const PASSKEY_FIELD = {
  created: "vault_passkeys_created",
  used: "vault_passkeys_used",
  fallback: "vault_passkeys_fallback",
  refused: "vault_passkeys_refused",
  timedOut: "vault_passkeys_refused",
  failed: "vault_passkeys_failed",
} as const;
const PASSKEY_VIA = {
  ardia: "vault_passkeys_via_ardia",
  chrome: "vault_passkeys_via_chrome",
  "extension:proton": "vault_passkeys_via_extension_proton",
  "extension:onepassword": "vault_passkeys_via_extension_onepassword",
  "extension:bitwarden": "vault_passkeys_via_extension_bitwarden",
  "extension:dashlane": "vault_passkeys_via_extension_dashlane",
  "extension:nordpass": "vault_passkeys_via_extension_nordpass",
  "extension:keeper": "vault_passkeys_via_extension_keeper",
  "extension:lastpass": "vault_passkeys_via_extension_lastpass",
  "extension:other": "vault_passkeys_via_extension_other",
} as const;
export const notePasskeyOutcome = (outcome: string, via: string | undefined, consent?: ConsentToken | null) => {
  const field = PASSKEY_FIELD[outcome as keyof typeof PASSKEY_FIELD];
  if (field) bump(field, consent);
  const route = via ? PASSKEY_VIA[via as keyof typeof PASSKEY_VIA] : undefined;
  if (route) bump(route, consent);
};
export const notePasskeyChooser = (consent?: ConsentToken | null) => bump("vault_passkey_chooser_shown", consent);
export const notePasskeyDeleted = (consent?: ConsentToken | null) => bump("vault_passkeys_deleted", consent);
export function noteVaultSignIn(ok: boolean, unlock = false, entryExpired = false, consent?: ConsentToken | null) {
  if (entryExpired) bump("vault_unlock_entries_expired", consent);
  if (unlock) bump(ok ? "vault_unlocks_typed" : "vault_unlock_failures", consent);
  else bump(ok ? "vault_sign_ins" : "vault_sign_in_failures", consent);
}
export const noteVaultTwoStep = (consent?: ConsentToken | null) => bump("vault_sign_in_two_step", consent);
export const noteVaultEarlyClickIgnored = () => bump("vault_menu_early_clicks_ignored");
export const noteStaleVaultProviderState = (consent?: ConsentToken | null) => bump("vault_stale_provider_states_ignored", consent);
export const noteVaultSignInCancelled = (consent?: ConsentToken | null) => bump("vault_sign_ins_cancelled", consent);
export const noteVaultLoginFailedAfterNavigation = (consent?: ConsentToken | null) => bump("vault_logins_failed_after_navigation", consent);
export const noteVaultCliCheck = (consent?: ConsentToken | null) => bump("vault_cli_checks", consent);
export const noteChromeDropdownHidden = (consent?: ConsentToken | null) => bump("vault_chrome_dropdowns_hidden", consent);
export const noteVaultMenuYieldedToChrome = (consent?: ConsentToken | null) => bump("vault_menu_yields_to_chrome", consent);
export function noteVaultPasswordUpdatedFromOffer(inManager: boolean, consent?: ConsentToken | null) {
  bump("vault_passwords_updated_from_offer", consent);
  if (inManager) bump("vault_logins_edited_manager", consent);
}

const BACKUP_FIELD = {
  backedUp: "vault_backups",
  failed: "vault_backup_failures",
  waiting: "vault_backup_key_waits",
  deleted: "vault_backup_deletes",
} as const;

export function noteVaultBackupChange(change: Pick<VaultBackupChange, "outcome">, consent?: ConsentToken | null) {
  if (change.outcome) bump(BACKUP_FIELD[change.outcome], consent);
}

export function noteVaultRestore(result: VaultRestoreResult, consent?: ConsentToken | null) {
  if (result.declined) return bump("vault_restores_declined", consent);
  bump("vault_restores", consent);
  bump("vault_logins_restored", consent, result.restored);
  bump("vault_logins_restore_failed", consent, result.failed);
}

export function noteVaultUpdateFromBackup(result: VaultRestoreResult, consent?: ConsentToken | null) {
  if (!result.declined) bump("vault_updates_from_backup", consent, result.restored);
}

const NATIVE_COUNTS = {
  reads: "vault_keychain_reads",
  readsFromMemory: "vault_keychain_reads_from_memory",
  writesSkipped: "vault_keychain_writes_skipped",
  loginKeychainCalls: "vault_login_keychain_calls",
  storeLegacyMigrated: "vault_store_legacy_migrated",
  storeNewerFormatKept: "vault_store_newer_format_kept",
  storeCloudNewerFormatKept: "vault_store_cloud_newer_format_kept",
  storeUnreadableKept: "vault_store_unreadable_kept",
  storeKeyReadFailed: "vault_store_key_read_failed",
  staleWorkDropped: "vault_stale_work_dropped",
  storeResealed: "vault_store_resealed",
  storeSetAside: "vault_store_set_aside",
  storeKeyNotNoted: "vault_store_key_not_noted",
  catalogBuilds: "vault_catalog_builds",
  catalogBuildsSlow: "vault_catalog_builds_slow",
} as const;

const countOf = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export async function pullVaultKeychainCounts() {
  const consent = consentToken();
  const native: (Partial<Record<keyof typeof NATIVE_COUNTS, unknown>> & { credential?: unknown }) | null = await Promise.resolve().then(takeVaultKeychainCounts).catch(() => null);
  if (!native) return;
  for (const [from, to] of Object.entries(NATIVE_COUNTS) as [keyof typeof NATIVE_COUNTS, (typeof NATIVE_COUNTS)[keyof typeof NATIVE_COUNTS]][]) {
    const n = countOf(native[from]);
    if (n) bump(to, consent, n);
  }
  const credential = native.credential && typeof native.credential === "object" ? (native.credential as Record<string, unknown>) : {};
  for (const [from, to] of Object.entries(CREDENTIAL_KINDS) as [keyof typeof CREDENTIAL_KINDS, (typeof CREDENTIAL_KINDS)[keyof typeof CREDENTIAL_KINDS]][]) {
    const byProvider = credential[from];
    if (!byProvider || typeof byProvider !== "object") continue;
    for (const [provider, n] of Object.entries(byProvider as Record<string, unknown>)) {
      const by = countOf(n);
      if (by) bump(`credential_${to}_${credentialCountName(provider)}`, consent, by);
    }
  }
}

let connectedProviders = new Set<CredentialName>();

export function noteCredentialProvidersConnected(providers: readonly string[]) {
  connectedProviders = new Set(providers.map(credentialCountName));
}

export function takeVaultCounts() {
  for (const name of connectedProviders) if (!counts[`credential_provider_connected_${name}`]) bump(`credential_provider_connected_${name}`);
  const taken = counts;
  counts = empty();
  void pullVaultKeychainCounts();
  return taken;
}
