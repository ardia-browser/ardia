import {
  call,
  type CallArgs,
  on,
  signInToVault,
  unlockVault as unlockNativeVault,
  type VaultGeneratedPassword,
  type VaultHandOn,
  type VaultGeneratedSaveResult,
  type VaultItem,
  type VaultProviderState,
  type VaultSecretField,
  type VaultSignInFields,
  type VaultSignInResult,
  type VaultSyncResult,
  type VaultCodeSource,
  type VaultTotp,
  type VaultBackupChange,
  type VaultPasswordStyle,
  type ChromeDropdownShown,
  type VaultPasskeyDone,
  type VaultPasskeyRequest,
} from "@ardia/ardiacore";

export type { VaultGeneratedPassword, VaultGeneratedSaveResult, VaultHandOn, VaultItem, VaultProviderState, VaultSignInFields, VaultSignInResult, VaultSyncResult, VaultTotp };
export type { VaultBackupChange, VaultBackupStatus, VaultRestoreResult } from "@ardia/ardiacore";
export type { ChromeDropdownKind, ChromeDropdownShown } from "@ardia/ardiacore";
export type { VaultCreateLoginResult, VaultStandaloneCode, VaultStandaloneCodeAdded, VaultStandaloneCodeEdited } from "@ardia/ardiacore";
export type { VaultPasskey, VaultPasskeyAnswer, VaultPasskeyDone, VaultPasskeyOutcome, VaultPasskeyRequest } from "@ardia/ardiacore";

export type VaultCopyField = VaultSecretField;

export const vaultProviders = () => call("vaults.providers");
export const claimChromeDropdownKinds = (tabId: string, kinds: ChromeDropdownShown[], usernames: string[] | null) =>
  call("vaults.claimChromeDropdowns", { tabId, kinds, usernames: usernames ?? [], anyLogin: usernames === null });
export const refreshVault = (provider: string) => call("vaults.refresh", { provider });
export const setArdiaProfiles = (ardiaProfiles: string[]) => call("vaults.refresh", { provider: "ardia", ardiaProfiles });
export const vaultSiteItems = (origin: string) => call("vaults.siteItems", { origin });
export const searchVaultItems = (query: string, limit: number, profile: string | null) => call("vaults.searchItems", { query, limit, ardiaProfile: profile });
export const vaultItemPage = ({ profile, ...args }: { query: string; offset: number; limit: number; managersOnly: boolean; profile: string | null }) =>
  call("vaults.listItems", { ...args, ardiaProfile: profile });
export const vaultUsernames = (email: boolean, limit: number, profile: string | null) => call("vaults.usernames", { email, limit, ardiaProfile: profile });
export const vaultItemsStatus = () => call("vaults.itemsStatus", {});
export const lockVault = (provider: string) => call("vaults.lock", { provider });
export const signOutVault = (provider: string) => call("vaults.signOut", { provider });
export const configureVault = (provider: string, server: string | null) => call("vaults.configure", { provider, server });
export const copyFromVault = (provider: string, id: string, field: VaultCopyField) => call("vaults.copy", { provider, id, field });
export const vaultTotp = (provider: string, id: string) => call("vaults.totp", { provider, id });
export const vaultCodesFor = (items: { provider: string; id: string }[]) => call("vaults.codesFor", { items });
export const onVaultCodesWarmed = (listener: (provider: string) => void) => on("vaults.codesWarmed", ({ provider }) => listener(provider));
export const cancelVaultSignIn = (provider: string) => call("vaults.cancelSignIn", { provider });
type VaultOptions = CallArgs<"vaults.setOptions">;
export const setVaultOptions = (options: VaultOptions) => call("vaults.setOptions", options);
export const exportVault = (provider: string, profile: string | null = null) => call("vaults.export", profile !== null ? { provider, profile } : { provider });
export const syncVaults = () => call("vaults.sync", {});
export const vaultSyncStatus = () => call("vaults.syncStatus", {});
export const warmVaults = (origin: string) => call("vaults.warm", { origin });
export const vaultBackupStatus = (profiles: string[]) => call("vaults.backupStatus", { profiles });
export const restoreVaultBackup = (profiles: string[]) => call("vaults.restoreBackup", { profiles });
export const updateFromVaultBackup = (profiles: string[]) => call("vaults.updateFromBackup", { profiles });
export const deleteVaultBackup = () => call("vaults.deleteBackup", {});
export const resumeVaultBackup = () => call("vaults.resumeBackup", {});
export const onVaultBackupChanged = (listener: (change: VaultBackupChange) => void) => on("vaults.backupChanged", listener);
export const vaultBiometrics = () => call("vaults.biometrics", {}).then((r) => r.available);
export const takeVaultKeychainCounts = () => call("vaults.keychainCounts", {});

export const listGeneratedPasswords = () => call("vaults.listGenerated", {});
export const copyGeneratedPassword = (id: string) => call("vaults.copyGenerated", { id });
export const saveGeneratedPassword = (id: string, provider: string, username: string | null, profile: string | null = null) =>
  call("vaults.saveGenerated", { id, provider, ...(username ? { username } : {}), ...(profile !== null ? { profile } : {}) });
export const deleteGeneratedPassword = (id: string) => call("vaults.deleteGenerated", { id });
export const setGeneratedRetention = (days: number) => call("vaults.setGeneratedRetention", { days });
export const addVaultTotp = (provider: string, id: string, token: string) => call("vaults.addTotp", { provider, id, token });
export type VaultLoginEdit = { profile?: string; username?: string; passwordDraft?: string; url?: string; totp?: { token: string } | { remove: true } };
export const editVaultLogin = (provider: string, id: string, edit: VaultLoginEdit) => call("vaults.edit", { provider, id, ...edit });
export const setVaultCodeSetup = (enabled: boolean) => call("webView.setVaultCodeSetup", { enabled });
export const removeVaultTotp = (provider: string, id: string) => call("vaults.removeTotp", { provider, id });
export const readVaultCode = (source: VaultCodeSource, origin: string, tabId?: string) =>
  call("vaults.readCode", tabId ? { source, origin, tabId } : { source, origin });
export const forgetVaultCodeOffer = (token: string) => call("vaults.forgetCode", { token });
export const copyVaultCode = (provider: string, id: string) => call("vaults.copyCode", { provider, id });
export const noteArdiaLoginChanged = (profile: string, origin: string, username: string, to: string | null) =>
  call("vaults.ardiaLoginChanged", { profile, origin, username, to });
export const importVaultCodes = (profile: string, path: string) => call("vaults.importCodes", { profile, path });
export const dropVaultTouchGrant = () => call("vaults.dropTouchGrant", {});
export const copyConcealed = (text: string) => call("vaults.copyConcealed", { text });
export const onGeneratedPasswordsChanged = (listener: () => void) => on("vaults.generatedChanged", () => listener());
export const newPasswordDraft = (style?: VaultPasswordStyle) => call("vaults.newPasswordDraft", style ? { style } : {});
export const dropPasswordDraft = (token: string) => call("vaults.dropPasswordDraft", { token });
export const createArdiaLogin = (login: { website: string; username: string; passwordDraft: string; profile: string; codeToken?: string }) => call("vaults.createLogin", login);
export const standaloneCodes = () => call("vaults.codes", {});
export const addStandaloneCode = (code: { token: string; label: string; issuer?: string; website?: string }) => call("vaults.addCode", code);
export const editStandaloneCode = (id: string, label: string, website: string) => call("vaults.editCode", website ? { id, label, website } : { id, label });
export const deleteStandaloneCode = (id: string) => call("vaults.deleteCode", { id });
export const onStandaloneCodesChanged = (listener: () => void) => on("vaults.codesChanged", () => listener());
export const vaultPasskeys = () => call("vaults.passkeys", {});
export const deleteVaultPasskey = (id: string) => call("vaults.deletePasskey", { id });
export const answerPasskey = (requestId: string, choice: string, target?: string) => call("vaults.passkeyAnswer", target ? { requestId, choice, target } : { requestId, choice });
export const setVaultPasskeys = (config: CallArgs<"vaults.setPasskeys">) => call("vaults.setPasskeys", config);
export const onPasskeyRequest = (listener: (request: VaultPasskeyRequest) => void) => on("vaults.passkeyRequest", listener);
export const onPasskeyOffer = (listener: (request: VaultPasskeyRequest) => void) => on("vaults.passkeyOffer", listener);
export const onPasskeyDone = (listener: (done: VaultPasskeyDone) => void) => on("vaults.passkeyDone", listener);
export const onPasskeysChanged = (listener: () => void) => on("vaults.passkeysChanged", () => listener());

export type CredentialProviderState = VaultProviderState;
export type VaultNeeds = NonNullable<VaultProviderState["needs"]>;
export type VaultNeedKind = VaultNeeds["kind"];
export type VaultSignInMethodSpec = NonNullable<VaultProviderState["signIn"]>["methods"][number];
export type VaultSignInFieldSpec = VaultSignInMethodSpec["fields"][number];
export type VaultServerSpec = NonNullable<NonNullable<VaultProviderState["signIn"]>["servers"]>[number];
export type VaultSignInRequest = { method: string; server?: string; values: Record<string, string>; secrets: Record<string, string> };
export type VaultAnswer = { need: VaultNeedKind; value?: string; entryToken?: string; methodId?: string; accountId?: string };

export const signInVault = (provider: string, request: VaultSignInRequest) => signInToVault(provider, request);
export const answerVault = (provider: string, answer: VaultAnswer) => call("vaults.answer", { provider, ...answer });
export const unlockVault = (provider: string, passwordEntry: string | null, handOn?: VaultHandOn) => unlockNativeVault(provider, passwordEntry, handOn);

export const onVaultChanged = (listener: (state: VaultProviderState, removed: boolean) => void) => on("vaults.changed", ({ provider, removed }) => listener(provider, removed === true));
export const onVaultApproval = (listener: (provider: string, url: string) => void) => on("vaults.openApproval", ({ provider, url }) => listener(provider, url));
export const onVaultItemsChanged = (listener: (provider: string, revision: number) => void) =>
  on("vaults.itemsChanged", ({ provider, revision }) => listener(provider, typeof revision === "number" ? revision : 0));

export type { VaultField, VaultFieldInset, VaultFieldKind, VaultFieldRect, VaultFillError, VaultFillField, VaultKeyPress, VaultPasswordDraft, VaultPasswordStyle, VaultSubmission, VaultTouchIDStatus } from "@ardia/ardiacore";
export type { VaultCodeRead, VaultCodeReadError, VaultCodeSource, VaultRemoveTotpResult } from "@ardia/ardiacore";
export type { VaultAddTotpResult, VaultEditError, VaultEditResult, VaultCodeAction, VaultCodeFound, VaultCodeLogin, VaultCodeMenu } from "@ardia/ardiacore";
export type { VaultContextAction, VaultContextChoice, VaultContextField, VaultContextLogin, VaultContextMenu, VaultFillTarget } from "@ardia/ardiacore";
