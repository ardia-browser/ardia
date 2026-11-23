import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const store = await import("./store.ts");
const menu = await import("./menu.ts");
const { usePlugins: pluginsForTest } = await import("../plugins/store.ts");
pluginsForTest.setState({ scanned: true });

const S = () => useBrowser.getState();
const caps = { totp: true, save: true, selfHosted: true, masterPassword: true, touchID: false };
const provider = (state) => ({ id: "bitwarden", name: "Bitwarden", state, capabilities: caps, install: { command: "brew install bitwarden-cli", url: "" } });
const login = { provider: "bitwarden", id: "gh", title: "GitHub", username: "octo", urls: ["https://github.com"], hasTotp: true };
const handle = { setVaultMenu: async () => {}, focus: async () => {}, discardVaultCapture: async () => {} };
const field = (over = {}) => ({ frameId: "f1", origin: "https://github.com", main: true, kind: "password", focused: true, rect: { x: 10, y: 100, width: 240, height: 28 }, formHasPassword: true, ...over });
const settle = () => new Promise((r) => setTimeout(r, 0));

async function setup() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://github.com/login" });
  const tabId = S().windows[w].tabIds[0];
  webviews.set(tabId, handle);
  native.vaultFakes.providers = [provider("unlocked")];
  native.vaultFakes.items = [login];
  S().updateSettings({ vaultSuggestOnFocus: true });
  store.clearVaultIndex();
  await store.loadVaultProviders();
  await store.loadAllVaultItems(true);
  await store.loadSiteItems("https://github.com");
  return { w, tabId };
}

async function openMenu(tabId) {
  menu.noteVaultField(tabId, field({ clicked: true }));
  await settle();
  return menu.vaultMenuOf(tabId);
}

test("a refresh asked for while the list is loading loads again once it lands", async () => {
  await setup();
  const lists = [[login], [{ ...login, title: "GitHub Work", updatedAt: 9 }]];
  let asked = 0;
  const plain = Object.getOwnPropertyDescriptor(native.vaultFakes, "items");
  Object.defineProperty(native.vaultFakes, "items", { configurable: true, get: () => lists[Math.min(asked++, 1)] });
  try {
    await Promise.all([store.loadVaultItems("bitwarden", true), store.loadVaultItems("bitwarden", true)]);
  } finally {
    Object.defineProperty(native.vaultFakes, "items", plain);
  }
  assert.equal(store.siteItemsNow("https://github.com")[0]?.title, "GitHub Work");
});

test("a list that lands after its manager locked and unlocked again is dropped", async () => {
  await setup();
  const plain = Object.getOwnPropertyDescriptor(native.vaultFakes, "items");
  let first = true;
  Object.defineProperty(native.vaultFakes, "items", { configurable: true, get: () => (first ? ((first = false), [{ ...login, title: "Stale" }]) : [login]) });
  try {
    const stale = store.loadVaultItems("bitwarden", true);
    store.applyProviderState(provider("locked"));
    native.vaultFakes.providers = [provider("unlocked")];
    store.applyProviderState(provider("unlocked"));
    await stale;
    await settle();
    await store.loadVaultItems("bitwarden");
  } finally {
    Object.defineProperty(native.vaultFakes, "items", plain);
  }
  assert.deepEqual(store.siteItemsNow("https://github.com").map((i) => i.title), ["GitHub"]);
});

test("closing a tab forgets its login field and its menu", async () => {
  const { w, tabId } = await setup();
  S().newTab(w, { url: "https://example.com" });
  const stop = menu.startVaultMenus();
  try {
    assert.ok(await openMenu(tabId));
    S().closeTab(tabId);
    assert.equal(tabId in menu.useVaultMenus.getState().fields, false);
    assert.equal(tabId in menu.useVaultMenus.getState().menus, false);
  } finally {
    stop();
  }
});

test("a manager locking under an open menu moves the highlight off a row that's gone", async () => {
  const { tabId } = await setup();
  const stop = menu.startVaultMenus();
  try {
    const opened = await openMenu(tabId);
    const suggest = menu.rowsOfMenu(opened).findIndex((r) => r.kind === "suggest");
    assert.ok(suggest > 0);
    menu.selectVaultRow(tabId, suggest);
    store.applyProviderState(provider("locked"));
    const now = menu.vaultMenuOf(tabId);
    assert.equal(menu.rowsOfMenu(now)[now.selected]?.kind, "unlock");
  } finally {
    stop();
  }
});
