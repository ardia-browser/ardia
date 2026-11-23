import { currentSettings } from "../../state/browser/current";
import { choosePasswordManager } from "../../state/site/passwordManager";
import { closeSettingsSheet } from "../../state/settings/sheet";
import { updateSettings } from "../../state/settings/actions";
import { openPasswordSettings, type VaultProviderState } from "../../state/vaults/actions";
import { showPreviewAdding, showPreviewCatalogue, type AddingManager, type CatalogueEntry } from "../../state/vaults/managerCatalogue";
import type { CredentialProviderState } from "../../state/vaults/providerModel";
import { showPreviewProviders } from "../../state/vaults/store";
import { showAddManagerSheet } from "../vaults/AddManagerSheet";
import type { SignInPreview } from "../vaults/ProviderSignInSheet";
import { showConnectSheet, showUnlockSheet } from "../settings/panes/PasswordManagerSheets";
import { FIXTURE_ACCENTS } from "./tokens";

const CAPS = { totp: true, save: true, selfHosted: false, masterPassword: false, touchID: true };
const ACCOUNT = "sam@example.com";

const onePassword = (patch: Partial<CredentialProviderState> = {}): CredentialProviderState => ({
  id: "1password",
  plugin: "1password",
  name: "1Password",
  title: "1Password",
  symbol: "key.horizontal.fill",
  accent: FIXTURE_ACCENTS.onePassword,
  state: "signedOut",
  capabilities: { ...CAPS, edit: true, addTotp: true },
  install: { command: "brew install 1password-cli", update: "brew upgrade 1password-cli", url: "https://www.1password.dev/cli/get-started/" },
  signIn: { methods: [{ id: "app", title: "1Password App", kind: "desktopApproval", fields: [], appURL: "onepassword://", appTitle: "1Password" }] },
  ...patch,
});

const bitwarden = (patch: Partial<CredentialProviderState> = {}): CredentialProviderState => ({
  id: "bitwarden",
  plugin: "bitwarden",
  name: "Bitwarden",
  title: "Bitwarden",
  symbol: "shield.lefthalf.filled",
  accent: FIXTURE_ACCENTS.bitwarden,
  state: "signedOut",
  capabilities: { ...CAPS, selfHosted: true, masterPassword: true, passkeys: true, edit: true, addTotp: true },
  install: { command: "brew install bitwarden-cli", update: "brew upgrade bitwarden-cli", url: "https://bitwarden.com/help/cli/" },
  signIn: {
    methods: [
      {
        id: "password",
        title: "Email and Password",
        kind: "credentials",
        fields: [
          { id: "email", title: "Email", kind: "email", placeholder: "name@example.com", prefill: "account" },
          { id: "masterPassword", title: "Master Password", kind: "secret" },
        ],
      },
      {
        id: "apiKey",
        title: "API Key",
        kind: "credentials",
        fields: [
          { id: "clientId", title: "Client ID", kind: "secret", masked: false, placeholder: "user.…" },
          { id: "clientSecret", title: "Client Secret", kind: "secret" },
          { id: "masterPassword", title: "Master Password", kind: "secret" },
        ],
      },
    ],
    servers: [
      { id: "us", title: "Bitwarden.com" },
      { id: "eu", title: "Bitwarden.eu" },
      { id: "selfHosted", title: "Self-Hosted", custom: true, placeholder: "vault.example.com" },
    ],
    unlockField: "masterPassword",
  },
  ...patch,
});

const protonPass = (patch: Partial<CredentialProviderState> = {}): CredentialProviderState => ({
  id: "protonpass",
  plugin: "protonpass",
  name: "Proton Pass",
  title: "Proton Pass",
  symbol: "lock.shield.fill",
  accent: FIXTURE_ACCENTS.protonPass,
  state: "signedOut",
  capabilities: CAPS,
  install: { command: "brew install protonpass/tap/pass-cli", update: "brew upgrade pass-cli", url: "https://protonpass.github.io/pass-cli/" },
  signIn: {
    methods: [
      { id: "browser", title: "Sign In with Browser", kind: "browserApproval", fields: [{ id: "extraPassword", title: "Extra Password", kind: "secret", optional: true }] },
      {
        id: "token",
        title: "Access Token",
        kind: "credentials",
        fields: [
          { id: "token", title: "Access Token", kind: "secret", placeholder: "Personal access token" },
          { id: "extraPassword", title: "Extra Password", kind: "secret", optional: true },
        ],
      },
    ],
  },
  ...patch,
});

const CATALOGUE: CatalogueEntry[] = [
  { name: "1password", title: "1Password", blurb: "", icon: "key.horizontal.fill", accent: FIXTURE_ACCENTS.onePassword, state: "available" },
  { name: "bitwarden", title: "Bitwarden", blurb: "", icon: "shield.lefthalf.filled", accent: FIXTURE_ACCENTS.bitwarden, state: "available" },
  { name: "protonpass", title: "Proton Pass", blurb: "", icon: "lock.shield.fill", accent: FIXTURE_ACCENTS.protonPass, state: "available" },
];

const CODE_METHODS = [
  { id: "0", title: "Authenticator App" },
  { id: "1", title: "Email" },
  { id: "3", title: "YubiKey" },
];

type Scene = { providers: CredentialProviderState[]; adding?: AddingManager };

const unlocked = { state: "unlocked" as const, account: ACCOUNT };

export const VAULT_SCENES: Record<string, Scene> = {
  none: { providers: [] },
  one: { providers: [bitwarden(unlocked)] },
  all: { providers: [onePassword(unlocked), bitwarden({ state: "locked", account: ACCOUNT }), protonPass()] },
  installing: { providers: [bitwarden(unlocked)], adding: { name: "protonpass", title: "Proton Pass", icon: "lock.shield.fill", accent: FIXTURE_ACCENTS.protonPass, phase: "installing", reason: "" } },
  installFailed: { providers: [bitwarden(unlocked)], adding: { name: "protonpass", title: "Proton Pass", icon: "lock.shield.fill", accent: FIXTURE_ACCENTS.protonPass, phase: "failed", reason: "Couldn't download it. Check your internet connection, then try again." } },
  consentCancelled: { providers: [bitwarden(unlocked)] },
  cliMissing: { providers: [bitwarden({ state: "notInstalled" })] },
  cliTooOld: { providers: [bitwarden({ problem: { code: "cliTooOld", message: "Needs Bitwarden CLI 2024.6.0 or later." } })] },
  signedOut: { providers: [protonPass()] },
  signingIn: { providers: [bitwarden({ needs: { kind: "code", methods: CODE_METHODS } })] },
  locked: { providers: [bitwarden({ state: "locked", account: ACCOUNT })] },
  unlocked: { providers: [onePassword(unlocked)] },
  selfHosted: { providers: [bitwarden({ ...unlocked, server: "https://vault.example.com" })] },
  crashed: { providers: [protonPass({ state: "unavailable", unavailable: { reason: "crashed", canRestart: true } })] },
  updating: { providers: [bitwarden({ state: "unavailable", unavailable: { reason: "updating", canRestart: false } })] },
  damaged: { providers: [bitwarden({ state: "unavailable", unavailable: { reason: "damaged", canRestart: false } })] },
  off: { providers: [onePassword({ state: "unavailable", unavailable: { reason: "off", canRestart: false } })] },
  offline: { providers: [protonPass({ ...unlocked, problem: { code: "offline", message: "Offline. Proton Pass fills again once you're back online." } })] },
  error: { providers: [bitwarden({ problem: { code: "failed", message: "Bitwarden couldn't reach its server. Check your connection." } })] },
};

type SheetScene = { provider: CredentialProviderState; preview?: SignInPreview; unlock?: { error?: string } };

export const VAULT_SHEETS: Record<string, SheetScene> = {
  bitwardenPassword: { provider: bitwarden({ account: ACCOUNT }) },
  bitwardenApiKey: { provider: bitwarden(), preview: { method: "apiKey" } },
  bitwardenSelfHosted: { provider: bitwarden(), preview: { server: { id: "selfHosted", url: "vault.example.com" } } },
  signingIn: { provider: bitwarden({ account: ACCOUNT }), preview: { busy: true } },
  signInError: { provider: bitwarden({ account: ACCOUNT }), preview: { error: "The email or master password isn't right." } },
  needsCode: { provider: bitwarden(), preview: { phase: "needs", needs: { kind: "code", methods: CODE_METHODS, message: "Enter the code from your authenticator app." } } },
  needsCodeWrong: { provider: bitwarden(), preview: { phase: "needs", needs: { kind: "code", methods: CODE_METHODS }, error: "That code isn't right. Try again." } },
  needsPassword: { provider: bitwarden(), preview: { phase: "needs", needs: { kind: "password" } } },
  needsEmail: { provider: bitwarden(), preview: { phase: "needs", needs: { kind: "email" } } },
  needsAccount: { provider: onePassword(), preview: { phase: "needs", needs: { kind: "account", accounts: [{ id: "a", title: "Personal" }, { id: "b", title: "Work" }] } } },
  onePassword: { provider: onePassword() },
  onePasswordWaiting: { provider: onePassword(), preview: { phase: "waiting" } },
  proton: { provider: protonPass() },
  protonWaiting: { provider: protonPass(), preview: { phase: "waiting", needs: { kind: "approval", approvalOpened: true } } },
  protonToken: { provider: protonPass(), preview: { method: "token" } },
  install: { provider: bitwarden({ state: "notInstalled" }) },
  outdated: { provider: bitwarden({ problem: { code: "cliTooOld", message: "Needs Bitwarden CLI 2024.6.0 or later." } }) },
  unlock: { provider: bitwarden({ state: "locked", account: ACCOUNT }), unlock: {} },
  unlockError: { provider: bitwarden({ state: "locked", account: ACCOUNT }), unlock: { error: "The master password isn't right." } },
};

function chooseArdiaHere() {
  const profileId = currentSettings().defaultProfileId;
  choosePasswordManager(profileId, "ardia");
  return profileId;
}

export function showVaultScene(name: string) {
  const scene = VAULT_SCENES[name];
  if (!scene) throw new Error(`No vault scene ${name}: ${Object.keys(VAULT_SCENES).join(", ")}`);
  closeSettingsSheet();
  showPreviewCatalogue(CATALOGUE);
  showPreviewProviders(scene.providers as VaultProviderState[]);
  showPreviewAdding(scene.adding ?? null);
  openPasswordSettings(chooseArdiaHere());
}

export function showVaultSheet(name: string) {
  const scene = VAULT_SHEETS[name];
  if (!scene) throw new Error(`No vault sheet ${name}: ${Object.keys(VAULT_SHEETS).join(", ")}`);
  showVaultScene("none");
  showPreviewProviders([scene.provider as VaultProviderState]);
  if (scene.unlock) showUnlockSheet(scene.provider.id, scene.unlock);
  else showConnectSheet(scene.provider.id, scene.preview);
}

export function showAddManagerScene() {
  showVaultScene("one");
  showAddManagerSheet((id) => showConnectSheet(id));
}

export function endVaultPreview() {
  closeSettingsSheet();
  showPreviewAdding(null);
  showPreviewCatalogue(null);
  showPreviewProviders(null);
}

export const previewAppearance = (appearance: "light" | "dark" | "auto") => updateSettings({ appearance });
