import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const store = await import("./store.ts");
const offers = await import("./saveOffer.ts");
const { usePlugins: pluginsForTest } = await import("../plugins/store.ts");
pluginsForTest.setState({ scanned: true });

const S = () => useBrowser.getState();

after(() => offers.forgetClosedVaultSaves({}));
const caps = { totp: true, save: true, selfHosted: true, masterPassword: true, touchID: false };
const provider = { id: "bitwarden", name: "Bitwarden", state: "unlocked", capabilities: caps, install: { command: "", url: "" } };
const submitted = { frameId: "f1", origin: "https://github.com", username: "new@example.com", usernameFrom: "form" };

async function setup() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://github.com/login" });
  const tabId = S().windows[w].tabIds[0];
  const discarded = [];
  webviews.set(tabId, { discardVaultCapture: async (r) => void discarded.push(r.origin), saveToVault: async () => ({ saved: true }) });
  native.vaultFakes.providers = [provider];
  native.vaultFakes.items = [];
  S().updateProfile("default", { passwordManager: "ardia" });
  S().updateSettings({ vaultSaveOffer: true, vaultAutoSave: false });
  store.clearVaultIndex();
  await store.loadVaultProviders();
  await store.loadAllVaultItems(true);
  return { tabId, discarded };
}

test("an offer someone is editing doesn't expire under them", async () => {
  const { tabId } = await setup();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await offers.noteVaultSubmitted(tabId, submitted);
    assert.ok(offers.useVaultSaveOffers.getState()[tabId]);
    mock.timers.tick(170_000);
    offers.editVaultOfferUsername(tabId);
    offers.setVaultOfferUsername(tabId, "typed@example.com");
    mock.timers.tick(30_000);
    assert.equal(offers.useVaultSaveOffers.getState()[tabId]?.username, "typed@example.com");
    mock.timers.tick(180_000);
    assert.equal(offers.useVaultSaveOffers.getState()[tabId] ?? null, null);
  } finally {
    mock.timers.reset();
  }
});

test("no offer appears after the profile left Ardia while it waited", async () => {
  const { tabId, discarded } = await setup();
  let release;
  native.vaultFakes.itemsGate = new Promise((r) => (release = r));
  store.clearVaultIndex();
  try {
    const pending = offers.noteVaultSubmitted(tabId, { ...submitted, username: "late@example.com" });
    S().updateProfile("default", { passwordManager: "none" });
    release();
    await pending;
  } finally {
    native.vaultFakes.itemsGate = null;
  }
  assert.equal(offers.useVaultSaveOffers.getState()[tabId] ?? null, null);
  assert.deepEqual(discarded, ["https://github.com"]);
});

test("no offer appears for a tab that closed while it waited", async () => {
  const { tabId } = await setup();
  let release;
  native.vaultFakes.itemsGate = new Promise((r) => (release = r));
  store.clearVaultIndex();
  try {
    const pending = offers.noteVaultSubmitted(tabId, { ...submitted, username: "gone@example.com" });
    S().closeTab(tabId);
    release();
    await pending;
  } finally {
    native.vaultFakes.itemsGate = null;
  }
  assert.equal(tabId in offers.useVaultSaveOffers.getState(), false);
});

test("a login that lands back on its form after the page navigates shows no offer", async () => {
  const { tabId, discarded } = await setup();
  const pending = offers.noteVaultSubmitted(tabId, { ...submitted, username: "wrong@example.com", reportsOutcome: true });
  offers.forgetVaultPageSaves(tabId);
  offers.noteVaultLoginOutcome(tabId, { origin: "https://github.com", ok: false });
  await pending;
  assert.equal(offers.useVaultSaveOffers.getState()[tabId] ?? null, null);
  assert.deepEqual(discarded, ["https://github.com"]);
});

test("a login whose landing page doesn't show the form again gets its offer", async () => {
  const { tabId } = await setup();
  const pending = offers.noteVaultSubmitted(tabId, { ...submitted, username: "right@example.com", reportsOutcome: true });
  offers.forgetVaultPageSaves(tabId);
  offers.noteVaultLoginOutcome(tabId, { origin: "https://github.com", ok: true });
  await pending;
  assert.equal(offers.useVaultSaveOffers.getState()[tabId]?.username, "right@example.com");
  offers.dismissVaultOffer(tabId);
});

test("a navigation that never hears how the login went shows no offer", async () => {
  const { tabId } = await setup();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = offers.noteVaultSubmitted(tabId, { ...submitted, username: "unknown@example.com", reportsOutcome: true });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    offers.forgetVaultPageSaves(tabId);
    mock.timers.tick(offers.NAVIGATED_OUTCOME_MS);
    await pending;
    assert.equal(offers.useVaultSaveOffers.getState()[tabId] ?? null, null);
  } finally {
    mock.timers.reset();
  }
});
