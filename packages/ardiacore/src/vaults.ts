import { decodeReply } from "./engine/call";
import { nativeModule } from "./nativeModules";

export type VaultProviderId = "1password" | "bitwarden" | "protonpass" | (string & {});
export type VaultState = "notInstalled" | "signedOut" | "locked" | "unlocked" | "unavailable";
export type VaultSecretField = "username" | "password";
export type VaultCopyError = "locked" | "notFound" | "failed" | "originMismatch" | "insecure" | "notAuthorized" | "clipboard";
export type VaultCapabilities = { totp: boolean; save: boolean; selfHosted: boolean; masterPassword: boolean; touchID: boolean; addTotp?: boolean; edit?: boolean; desktopApproval?: boolean; passkeys?: boolean };
export type VaultSetupKind = "desktopIntegration" | "browserSignIn" | "credentials";

export type VaultProviderState = {
  id: VaultProviderId;
  name: string;
  state: VaultState;
  account?: string;
  server?: string;
  cliPath?: string;
  cliVersion?: string;
  message?: string;
  capabilities: VaultCapabilities;
  install: { command: string; url: string; update?: string };
  setup?: { kind: VaultSetupKind; appURL?: string };
  touchUnlock?: boolean;
  plugin?: string;
  title?: string;
  symbol?: string;
  accent?: string;
  signIn?: VaultSignInDescriptor;
  needs?: VaultProviderNeeds;
  problem?: { code: string; message: string };
  unavailable?: { reason: "crashed" | "updating" | "damaged" | "off"; canRestart: boolean };
};

export type VaultSignInFieldKind = "text" | "email" | "secret" | "url" | "code";

export type VaultSignInDescriptor = {
  methods: Array<{
    id: string;
    title: string;
    kind: "credentials" | "desktopApproval" | "browserApproval";
    fields: Array<{ id: string; title: string; kind: VaultSignInFieldKind; optional?: boolean; placeholder?: string; hint?: string; masked?: boolean; prefill?: "account" }>;
    appURL?: string;
    appTitle?: string;
    twoStep?: boolean;
  }>;
  servers?: Array<{ id: string; title: string; url?: string; custom?: boolean; placeholder?: string; fieldTitle?: string }>;
  unlockField?: string;
};

export type VaultChoice = { id: string; title: string; sendsCode?: boolean };

export type VaultProviderNeeds = {
  kind: "code" | "password" | "email" | "approval" | "account" | "field";
  field?: string;
  methods?: VaultChoice[];
  accounts?: VaultChoice[];
  approvalOpened?: boolean;
  message?: string;
};

export type VaultUrlMatch = "" | "host" | "exact";

export type VaultItem = {
  provider: VaultProviderId;
  id: string;
  title: string;
  username: string;
  urls: string[];
  urlMatch?: VaultUrlMatch[];
  hasTotp?: boolean;
  vault?: string;
  favorite?: boolean;
  updatedAt?: number;
  profile?: string;
  passkey?: { requestId: string; credentialId: string };
  match?: VaultItemMatch;
};

export type VaultItemMatch = { tier: number; reason: "origin" | "site" | "shared" | "brand"; site?: string };

export type VaultSiteItems = { items: VaultItem[]; listed: VaultProviderId[]; revision: number };
export type VaultItemSearch = { items: VaultItem[]; revision: number; cancelled?: boolean };
export type VaultItemPage = { total: number; items: VaultItem[]; revision: number };
export type VaultItemsStatus = { revision: number; listed: VaultProviderId[]; counts: Record<VaultProviderId, number> };

export type VaultSignInMethod = { id: string; name: string; sendsCode?: boolean };

export type VaultSignInResult = {
  ok: boolean;
  state: VaultProviderState;
  needs?: "code" | "password" | "email" | "approval" | "account" | "field";
  field?: string;
  methods?: VaultSignInMethod[];
  accounts?: VaultChoice[];
  error?: string;
  approvalURL?: string;
  entryExpired?: boolean;
};

export type VaultSignInAnswer = { need: string; value?: string; entryToken?: string; methodId?: string; accountId?: string };

export type VaultSignInFields = {
  method?: string;
  values?: Record<string, string>;
  secrets?: Record<string, string>;
  email?: string;
  password?: string;
  code?: string;
  server?: string;
  clientId?: string;
  clientSecret?: string;
  account?: string;
  passwordEntry?: string;
  clientSecretEntry?: string;
};

export type VaultCopyResult = { copied: boolean; declined?: boolean; error?: VaultCopyError; clearsAfter: number };

export type VaultTotp = { code: string; period: number; expiresAt: number; next?: string };

export type VaultGeneratedPassword = { id: string; origin: string; username: string; createdAt: number; submitted: boolean };

export type VaultGeneratedSaveResult = { saved: boolean; item?: VaultItem; error?: string };
export type VaultAddTotpError = "locked" | "notFound" | "unsupported" | "invalid" | "expired" | "declined" | "failed";
export type VaultAddTotpResult = { added: boolean; item?: VaultItem; error?: VaultAddTotpError; message?: string };
export type VaultEditError = "locked" | "notFound" | "unsupported" | "invalid" | "declined" | "failed";
export type VaultEditResult = { edited: boolean; item?: VaultItem; error?: VaultEditError; message?: string };
export type VaultRemoveTotpResult = { removed: boolean; error?: VaultAddTotpError };
export type VaultCodeSource = "clipboard" | "image" | "page";
export type VaultCreateLoginResult = { saved: boolean; codeAdded: boolean; item?: VaultItem; error?: "exists" | "invalid" | "needsPassword" | "expired" | "declined" | "failed" };
export type VaultStandaloneCode = { id: string; label: string; issuer?: string; website?: string; period?: number; createdAt?: number };
export type VaultStandaloneCodeAdded = { added: boolean; code?: VaultStandaloneCode; error?: "expired" | "invalid" | "exists" | "declined" | "failed"; id?: string };
export type VaultStandaloneCodeEdited = { saved: boolean; code?: VaultStandaloneCode; error?: "notFound" | "invalid" | "failed" };
export type VaultCodeReadError = "none" | "many" | "declined" | "unreadable";
export type VaultPasskey = { id: string; provider: VaultProviderId; rpId: string; userName: string; displayName: string; createdAt?: number; origin?: string; item?: string };
export type VaultPasskeyRequest = {
  tabId: string;
  epoch?: string;
  requestId: string;
  kind: "create" | "get";
  conditional: boolean;
  origin: string;
  rpId: string;
  passkeys: VaultPasskey[];
  system: boolean;
  private: boolean;
  userName?: string;
  displayName?: string;
  exists?: boolean;
  extensions?: { id: string; name: string }[];
  choose?: boolean;
  ardia?: boolean;
};
export type VaultPasskeyOutcome = "created" | "used" | "fallback" | "refused" | "cancelled" | "timedOut" | "failed" | "extension";
export type VaultPasskeyDone = { tabId: string; requestId: string; outcome: VaultPasskeyOutcome; via?: string; epoch?: string };
export type VaultPasskeyAnswer = { ok: boolean; error?: "gone" | "busy" | "invalid" | "declined" | "failed" | "unavailable"; message?: string };
export type VaultCodeRead = { token: string; issuer: string; account: string; error?: undefined } | { error: VaultCodeReadError; token?: undefined };

export type VaultBackupState = "off" | "never" | "backedUp" | "waitingForKeychain" | "waitingForICloud" | "failed" | "deleted" | "needsUpdate";
export type VaultBackupStatus = {
  state: VaultBackupState;
  backedUpAt: number | null;
  problem?: "unreadable" | "iCloud";
  restorable?: number;
  updatable?: number;
};
export type VaultBackupChange = VaultBackupStatus & { outcome?: "backedUp" | "failed" | "waiting" | "deleted"; epoch?: string };
export type VaultBackupDeleteResult = { deleted: boolean; declined: boolean };
export type VaultRestoreResult = { restored: number; failed: number; declined: boolean };

export type VaultSyncResult = { ok: boolean; synced: VaultProviderId[]; failed: VaultProviderId[]; syncedAt: number | null; iCloud: boolean; backup?: VaultBackupStatus };

const Vaults = nativeModule("ArdiaVaults");

export const signInToVault = (provider: VaultProviderId, fields: VaultSignInFields) =>
  decodeReply<VaultSignInResult>(Vaults.signIn(provider, JSON.stringify(fields)));
export type VaultHandOn = { tab: string; origin: string };
export const unlockVault = (provider: VaultProviderId, passwordEntry: string | null, handOn?: VaultHandOn) =>
  decodeReply<VaultSignInResult>(Vaults.unlock(provider, passwordEntry, handOn?.tab ?? null, handOn?.origin ?? null));
