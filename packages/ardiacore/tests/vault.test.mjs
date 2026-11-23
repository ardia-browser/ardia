import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";
import { HOSTILE_STRINGS } from "../../../scripts/security/hostile-inputs.mjs";

const wellFormed = (text) => !/[\ud800-\udfff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""));
const HOSTILE_ENV = { ARDIA_HOSTILE_INPUTS: JSON.stringify(HOSTILE_STRINGS.filter((h) => wellFormed(h.value)).map((h) => [h.id, h.value])) };

const suites = [
  ["vault-broker", ["-O"], ["VaultOriginMatch", "VaultPublicSuffixRules", "VaultCommand", "VaultCommandResult", "VaultLane", "VaultLockEpoch", "VaultState", "VaultCloudAccount"]],
  ["vault-totp", [], ["VaultTotp", "VaultTotpSecret", "VaultTotpURI", "VaultCodeImport", "ArdiaStandaloneCode", "VaultOriginMatch", "VaultPublicSuffixRules", "VaultTouchGrants", "VaultClipboardDue"]],
  ["vault-sync", [], ["ArdiaVaultProfiles", "ArdiaVaultLogin", "ArdiaVaultFile", "ArdiaStandaloneCode", "VaultOriginMatch", "VaultPublicSuffixRules", "VaultLedger", "VaultSealed", "VaultCacheSnapshot", "VaultCloudFiles", "ArdiaSecretCache", "VaultItem", "VaultJSON", "VaultError"]],
  ["vault-edit", [], ["VaultLoginEdit", "VaultJSON", "VaultError", "VaultItem", "VaultTotp", "VaultTotpSecret", "VaultTotpURI", "VaultOriginMatch", "VaultPublicSuffixRules"]],
  ["vault-secrets", [], ["VaultSecretPlace", "VaultSecretShelf", "VaultSecretFile", "VaultSealed", "VaultSealedFolder", "VaultTouchGrants"]],
  ["vault-passkeys", [], ["VaultWebAuthn", "VaultPasskey", "VaultPasskeyRoute", "VaultPasskeyExtensionScan", "VaultItem", "VaultJSON", "VaultError", "VaultOriginMatch", "VaultPublicSuffixRules", "ArdiaVaultLogin", "ArdiaVaultFile", "ArdiaStandaloneCode", "VaultLedger", "VaultSealed", "VaultCacheSnapshot"]],
  ["vault-catalog", ["-O"], ["VaultCatalog", "VaultOffMain", "VaultItem", "VaultOriginMatch", "VaultPublicSuffixRules"]],
  ["vault-off-main", ["-DDEBUG"], ["VaultOffMain"]],
  ["vault-totp-warm", ["-O"], ["VaultTotpWarm", "VaultTotpSecret", "VaultTotp", "VaultTotpURI", "VaultCacheSnapshot", "VaultItem", "VaultJSON", "VaultError", "VaultOriginMatch", "VaultPublicSuffixRules"]],
  ["vault-cache-writer", [], ["VaultCacheWriter", "VaultCacheSnapshot", "VaultItem", "VaultJSON", "VaultError"]],
  ["vault-revealed-field", [], ["VaultRevealedFieldEditor"]],
  ["vault-secret-entries", [], ["VaultSecretEntries"]],
  ["vault-touch-scopes", [], ["VaultTouchGrants"]],
  ["vault-store", [], ["VaultSealed", "VaultSealedFolder", "VaultStoreKeyPlan", "VaultKeyRing", "VaultSecretShelf", "VaultTouchGrants", "VaultOwnerPrompt", "VaultGeneratedStore", "VaultExportFile"]],
  ["autofill-card", [], ["AutofillCardNumber"]],
  ["credential-verbs", [], ["CredentialLimits", "CredentialCatalog", "CredentialCatalogParser", "CredentialCatalogParser+Cli", "CredentialVerbLaunch"]],
  ["credential-output", [], [
    "CredentialLimits", "CredentialCatalog", "CredentialCatalogParser", "CredentialCatalogParser+Cli", "CredentialVerbLaunch", "CredentialVerbOutput", "VaultOffMain", "CredentialWording", "CredentialResults",
    "VaultCommandResult", "VaultJSON", "VaultError", "VaultItem", "VaultItemList", "VaultState", "VaultWebAuthn", "VaultOriginMatch", "VaultPublicSuffixRules",
  ]],
  ["credential-locator", [], ["VaultBinaryLocator", "CredentialHost", "VaultCommand", "VaultCommandResult", "VaultLockEpoch"]],
  ["credential-run", [], [
    "CredentialLimits", "CredentialCatalog", "CredentialCatalogParser", "CredentialCatalogParser+Cli", "CredentialVerbLaunch", "CredentialVerbOutput", "VaultOffMain", "CredentialWording",
    "CredentialResults", "CredentialHandles", "CredentialHost", "CredentialRunEndpoint", "PluginVaultProvider", "PluginVaultProvider+SignIn", "VaultPasskeyHolder", "VaultPasskey",
    "VaultProvider", "VaultCLI", "VaultCommand", "VaultCommandResult", "VaultLockEpoch", "VaultJSON", "VaultError", "VaultItem", "VaultItemList",
    "VaultState", "VaultWebAuthn", "VaultOriginMatch", "VaultPublicSuffixRules", "VaultCapabilities", "VaultInstall", "VaultSetup", "VaultSetupKind",
    "VaultProviderState", "VaultSignInFields", "VaultSignInFields+JSON", "VaultSignInResult", "VaultSignInNeed", "VaultMethod", "VaultField",
    "VaultNewLogin", "VaultLoginEdit", "VaultTotp", "VaultTotpSecret", "VaultTotpURI", "VaultMessages", "VaultNetwork", "VaultSecretEntries",
  ]],
];

for (const [name, flags, sources] of suites) {
  test(`the ${name} Swift Testing suite passes`, (t) => {
    runSwiftTests(t, `${name}-test`, [...sources.map((source) => `../ios/${source}.swift`), `./${name}.test.swift`], {
      flags: [...flags, "-swift-version", "6"],
      env: name === "credential-output" ? HOSTILE_ENV : {},
    });
  });
}
