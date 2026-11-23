import assert from "node:assert/strict";
import { test } from "node:test";

const native = { calls: { bitwarden: 3, "my-vault": 2 }, callFailures: { "1password": 1 }, verbRefusals: { protonpass: 4, bitwarden: -1 } };
const { vaultFakes } = await import("../../test-native/index.ts");
const { setConsentPeriod } = await import("./consentPeriod.ts");
const { credentialCountName, noteCredentialProvidersConnected, pullVaultKeychainCounts, takeVaultCounts } = await import("./vaultCounts.ts");
const { WHATS_SENT } = await import("./copy.ts");

test("only Ardia's official password managers are counted by name; any other plugin is folded into other", () => {
  assert.deepEqual(["1password", "bitwarden", "protonpass", "my-vault", "other", ""].map(credentialCountName), ["1password", "bitwarden", "protonpass", "other", "other", "other"]);
});

test("native credential counts and who is signed in reach the hourly counts while sharing is on, and nothing while it is off", async () => {
  setConsentPeriod(true, "credential-counts");
  takeVaultCounts();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vaultFakes.keychainCounts = { reads: 0, readsFromMemory: 0, writesSkipped: 0, loginKeychainCalls: 0, credential: native };
  await pullVaultKeychainCounts();
  noteCredentialProvidersConnected(["bitwarden", "someone-else"]);
  const on = takeVaultCounts();
  assert.equal(on.credential_calls_bitwarden, 3);
  assert.equal(on.credential_calls_other, 2);
  assert.equal(on.credential_call_failures_1password, 1);
  assert.equal(on.credential_verb_refusals_protonpass, 4);
  assert.equal(on.credential_verb_refusals_bitwarden, 0);
  assert.equal(on.credential_provider_connected_bitwarden, 1);
  assert.equal(on.credential_provider_connected_other, 1);
  assert.equal(on.credential_provider_connected_1password, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  setConsentPeriod(false, "credential-counts-off");
  vaultFakes.keychainCounts = { reads: 0, readsFromMemory: 0, writesSkipped: 0, loginKeychainCalls: 0, credential: native };
  await pullVaultKeychainCounts();
  const off = takeVaultCounts();
  assert.equal(Object.entries(off).filter(([k, v]) => k.startsWith("credential_") && v).length, 0);
});

test("What's Sent says these counts exist and what they never carry", () => {
  assert.ok(WHATS_SENT.some((group) => group.items.some((item) => item.includes("1Password, Bitwarden and Proton Pass") && item.includes("Never what was asked"))));
});
