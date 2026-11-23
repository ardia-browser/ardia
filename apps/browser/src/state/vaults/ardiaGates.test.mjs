import assert from "node:assert/strict";
import { after, test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { store: storeResource } = await import("../settings/resources.ts");
const { passwordAutofill } = await import("../site/passwordManager.ts");
const { recordArdiaChoice } = await import("../site/ardiaChoice.ts");
const { requestAutofill } = await import("../site/autofill.ts");
const { markTabReady } = await import("../tabs/pageState.ts");
const enabled = await import("./enabled.ts");
const { startArdiaScope } = await import("./ardiaScope.ts");
const vaults = await import("./store.ts");
const menu = await import("./menu.ts");
const offers = await import("./saveOffer.ts");
const passkeys = await import("./passkeys.ts");
const sync = await import("./sync.ts");
const { takeVaultCounts } = await import("../telemetry/vaultCounts.ts");

const S = () => useBrowser.getState();
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const caps = { totp: true, save: true, selfHosted: true, masterPassword: true, touchID: false };
const ardia = { id: "ardia", name: "Ardia", state: "unlocked", capabilities: caps, install: { command: "", url: "" } };
const field = { frameId: "f1", origin: "https://github.com", main: true, kind: "password", focused: true, rect: { x: 10, y: 100, width: 240, height: 28 }, formHasPassword: true };
const submitted = { frameId: "f1", origin: "https://github.com", username: "new@example.com", usernameFrom: "form", reportsOutcome: true };

setConsentPeriod(true, "gates-test");
after(() => offers.forgetClosedVaultSaves({}));

let work = "";
let tabId = "";

test("before the plugin scan finishes, a profile stored on a plugin is not on Ardia and connecting records nothing", () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  work = S().createProfile({ name: "Work" });
  S().updateProfile(work, { passwordManager: "plugin:other-passwords" });
  const fresh = S().createProfile({ name: "Fresh" });
  assert.equal(usePlugins.getState().scanned, false);
  assert.equal(enabled.vaultsOnForProfile(work), false);
  assert.equal(enabled.vaultsOnForProfile("default"), false, "no profile is on Ardia until the scan says which plugins exist");
  assert.deepEqual(enabled.ardiaProfiles(), []);
  assert.equal(recordArdiaChoice(fresh), false);
  assert.equal(S().profiles[fresh].passwordManager, undefined);
  S().updateProfile(fresh, { passwordManager: "none" });
});

test("after the scan, a plugin profile whose plugin is still on but unreadable stays off Ardia; once the plugin is off it follows the effective choice", () => {
  usePlugins.setState({ scanned: true, records: { "other-passwords": { enabled: true, approved: "h", values: {}, applied: {} } } });
  assert.equal(enabled.vaultsOnForProfile("default"), true);
  assert.equal(enabled.vaultsOnForProfile(work), false, "a missing manifest never flips the profile to Ardia");
  usePlugins.setState({ records: {} });
  assert.equal(enabled.vaultsOnForProfile(work), true);
  S().updateProfile(work, { passwordManager: "none" });
});

test("native gets the engine profile names of the profiles on Ardia, so the Default profile is sent as \"\"", async () => {
  native.vaultFakes.ardiaProfiles.length = 0;
  startArdiaScope();
  await settle();
  assert.deepEqual(native.vaultFakes.ardiaProfiles.at(-1), [""]);
  const shared = S().createProfile({ name: "Shared", shareWith: "default" });
  S().updateProfile(shared, { passwordManager: "ardia" });
  await settle();
  assert.deepEqual(native.vaultFakes.ardiaProfiles.at(-1), [""], "a profile sharing Default's data maps to the same engine profile");
});

async function ardiaTab() {
  S().updateProfile("default", { passwordManager: "ardia" });
  const w = S().createWindow({ url: "https://github.com/login", profileId: "default" });
  tabId = S().windows[w].tabIds[0];
  markTabReady(tabId);
  webviews.set(tabId, { setVaultMenu: async () => undefined, discardVaultCapture: async () => undefined, saveToVault: async () => ({ saved: true }), focus: async () => undefined });
  native.vaultFakes.providers = [ardia];
  native.vaultFakes.items = [];
  S().updateSettings({ vaultSaveOffer: true, vaultSuggestOnFocus: true });
  await vaults.loadVaultProviders();
  return w;
}

test("an Ardia profile with Save and Fill off and no manager connected keeps Ardia's own menu, never Chrome's, and offers no save", async () => {
  const w = await ardiaTab();
  storeResource(passwordAutofill, [""], false);
  menu.noteVaultField(tabId, field);
  await settle();
  assert.equal(menu.openVaultMenuOnDemand(tabId), true, "Ardia's menu, with its own empty state, stands in for Chrome's");
  menu.closeVaultMenu(tabId);
  assert.equal(offers.vaultClaimsPasswordPrompt(tabId, { origin: "https://github.com", state: "save" }), false);
  await offers.noteVaultSubmitted(tabId, { ...submitted, reportsOutcome: false });
  assert.equal(offers.useVaultSaveOffers.getState()[tabId] ?? null, null, "Save and Fill off still means no offer to save");
  native.autofillFakes.suggestionsShown.length = 0;
  await requestAutofill(w, "passwords", tabId);
  assert.deepEqual(native.autofillFakes.suggestionsShown, [], "Cmd-\\ never asks Chrome for its suggestions on an Ardia profile");
  assert.ok(menu.vaultMenuOf(tabId), "it opens Ardia's menu instead");
  menu.closeVaultMenu(tabId);
  storeResource(passwordAutofill, [""], true);
});

test("a failed login after navigation counts in the consent period the submit arrived in", async () => {
  takeVaultCounts();
  const pending = offers.noteVaultSubmitted(tabId, { ...submitted, username: "late@example.com" });
  await settle();
  offers.forgetVaultPageSaves(tabId);
  setConsentPeriod(true, "gates-test-later");
  offers.noteVaultLoginOutcome(tabId, { origin: "https://github.com", ok: false });
  await pending;
  assert.equal(takeVaultCounts().vault_logins_failed_after_navigation, 0, "the submit's period ended, so the count stays local");
  setConsentPeriod(true, "gates-test");
});

test("native vault events count only in the consent period they were stamped in", async () => {
  passkeys.startPasskeys();
  sync.startVaultBackupWatch();
  takeVaultCounts();
  native.emitEvent("vaults.passkeyDone", { tabId, requestId: "", outcome: "used", via: "ardia", epoch: "an-old-period" });
  native.emitEvent("vaults.backupChanged", { outcome: "backedUp", epoch: "an-old-period" });
  await settle();
  let counts = takeVaultCounts();
  assert.deepEqual([counts.vault_passkeys_used, counts.vault_backups], [0, 0]);
  native.emitEvent("vaults.passkeyDone", { tabId, requestId: "", outcome: "used", via: "ardia", epoch: "gates-test" });
  native.emitEvent("vaults.backupChanged", { outcome: "backedUp", epoch: "gates-test" });
  await settle();
  counts = takeVaultCounts();
  assert.deepEqual([counts.vault_passkeys_used, counts.vault_backups], [1, 1]);
});

test("Chrome's login and passkey dropdowns are claimed on every tab of an Ardia profile, and left alone on profiles set to None or a plugin", async () => {
  const { chromeDropdownPolicy, startChromeDropdownPolicy } = await import("./dropdownPolicy.ts");
  assert.deepEqual(chromeDropdownPolicy(true), ["login", "passkey"]);
  assert.deepEqual(chromeDropdownPolicy(false), []);
  await ardiaTab();
  S().updateProfile(work, { passwordManager: "none" });
  const elsewhere = S().createWindow({ url: "https://github.com/login", profileId: work });
  const noneTab = S().windows[elsewhere].tabIds[0];
  native.vaultFakes.dropdownClaims.length = 0;
  const stop = startChromeDropdownPolicy();
  try {
    await settle();
    const claimsOf = (id) => native.vaultFakes.dropdownClaims.filter((c) => c.tabId === id).map((c) => `${c.kinds.join(",")}${c.anyLogin ? " any" : ""}`);
    assert.deepEqual(claimsOf(tabId), ["login,passkey any"], "an Ardia profile's tab never shows Chrome's password or passkey dropdown, menu or not");
    assert.deepEqual(claimsOf(noneTab), [], "a profile on None keeps Chrome's dropdowns");
    S().updateProfile(work, { passwordManager: "ardia" });
    await settle();
    assert.deepEqual(claimsOf(noneTab), ["login,passkey any"], "switching that profile to Ardia claims them");
  } finally {
    stop();
    S().updateProfile(work, { passwordManager: "none" });
  }
});
