import test from "node:test";
import { runSwiftTests } from "./swift-testing.mjs";

const suites = [
  ["vault-broker", ["-O"], ["VaultOriginMatch", "VaultPublicSuffixRules", "VaultCommand", "VaultCommandResult", "VaultLane", "VaultLockEpoch", "VaultState", "VaultCloudAccount"]],
  ["vault-totp", [], ["VaultTotp", "VaultTotpSecret", "VaultTotpURI", "VaultCodeImport", "ArdiaStandaloneCode", "VaultOriginMatch", "VaultPublicSuffixRules", "VaultTouchGrants", "VaultClipboardDue"]],
  ["vault-sync", [], ["ArdiaVaultProfiles", "ArdiaVaultLogin", "ArdiaVaultFile", "ArdiaStandaloneCode", "VaultOriginMatch", "VaultPublicSuffixRules", "VaultLedger", "VaultSealed", "VaultCacheSnapshot", "VaultCloudFiles", "ArdiaSecretCache", "VaultItem", "VaultJSON", "VaultError"]],
  ["vault-edit", [], ["VaultLoginEdit", "VaultJSON", "VaultError", "VaultItem", "VaultTotp", "VaultTotpSecret", "VaultTotpURI", "VaultOriginMatch", "VaultPublicSuffixRules"]],
  ["vault-secrets", [], ["VaultSecretPlace", "VaultSecretShelf", "VaultSecretFile", "VaultSealed", "VaultSealedFolder", "VaultTouchGrants"]],
  ["vault-passkeys", [], ["VaultWebAuthn", "VaultPasskey", "VaultPasskeyRoute", "VaultPasskeyExtensionScan", "VaultItem", "VaultJSON", "VaultError", "VaultOriginMatch", "VaultPublicSuffixRules", "ArdiaVaultLogin", "ArdiaVaultFile", "ArdiaStandaloneCode", "VaultLedger", "VaultSealed", "VaultCacheSnapshot"]],
  ["vault-revealed-field", [], ["VaultRevealedFieldEditor"]],
  ["vault-secret-entries", [], ["VaultSecretEntries"]],
  ["vault-touch-scopes", [], ["VaultTouchGrants"]],
  ["vault-store", [], ["VaultSealed", "VaultSealedFolder", "VaultStoreKeyPlan", "VaultKeyRing", "VaultSecretShelf", "VaultTouchGrants", "VaultOwnerPrompt", "VaultGeneratedStore", "VaultExportFile"]],
];

for (const [name, flags, sources] of suites) {
  test(`the ${name} Swift Testing suite passes`, (t) => {
    runSwiftTests(t, `${name}-test`, [...sources.map((source) => `../ios/${source}.swift`), `./${name}.test.swift`], {
      flags: [...flags, "-swift-version", "6"],
    });
  });
}
