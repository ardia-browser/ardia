import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const store = await import("./store.ts");
const menu = await import("./menu.ts");
const { fetchManagerRows, ITEM_PAGE_MOST } = await import("./itemPages.ts");
const { loginEntries, mergeSorted, savedEntries } = await import("../../components/settings/panes/savedEntries.ts");
const { usePlugins } = await import("../plugins/store.ts");
usePlugins.setState({ scanned: true });

const S = () => useBrowser.getState();
const caps = { totp: true, save: true, selfHosted: true, masterPassword: true, touchID: false };
const bitwarden = { id: "bitwarden", name: "Bitwarden", state: "unlocked", capabilities: caps, install: { command: "", url: "" } };
const settle = () => new Promise((r) => setTimeout(r, 0));
const field = (over = {}) => ({ frameId: "f1", origin: "https://github.com", main: true, kind: "password", focused: true, clicked: true, rect: { x: 10, y: 100, width: 240, height: 28 }, formHasPassword: true, ...over });
const login = (id, site, username = `user${id}`) => ({ provider: "bitwarden", id: String(id), title: site, username, urls: [`https://${site}`], hasTotp: false });
const vaultCalls = () => native.engineCalls.filter((c) => c.domain === "vaults").map((c) => c.verb);
const held = () => {
  const s = store.useVaults.getState();
  return [...Object.values(s.sites), ...Object.values(s.searches)].flat();
};

const bigVault = () => [login("gh1", "github.com", "octo"), login("gh2", "gist.github.com", "octo-gist"), ...Array.from({ length: 3000 }, (_, i) => login(i, `site${i}.example`))];

async function setup() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://github.com/login" });
  const tabId = S().windows[w].tabIds[0];
  webviews.set(tabId, { setVaultMenu: async () => {}, focus: async () => {}, discardVaultCapture: async () => {}, fillFromVault: async () => ({ filled: [] }) });
  native.vaultFakes.providers = [bitwarden];
  native.vaultFakes.items = bigVault();
  S().updateSettings({ vaultSuggestOnFocus: true });
  store.clearVaultIndex();
  await store.loadVaultProviders();
  await store.loadAllVaultItems(true);
  native.engineCalls.length = 0;
  return { tabId };
}

test("the fill menu gets only the page's site from native, never the whole vault", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field());
  await settle();
  await settle();
  const open = menu.vaultMenuOf(tabId);
  assert.deepEqual(menu.rowsOfMenu(open).filter((r) => r.kind === "login").map((r) => r.item.id), ["gh1", "gh2"]);
  assert.ok(vaultCalls().includes("siteItems"));
  assert.ok(!vaultCalls().includes("items"), "no call asks for every login");
  assert.ok(held().length <= 2, `JS holds ${held().length} logins for one site out of ${native.vaultFakes.items.length}`);
});

test("Other Passwords searches natively and its rows follow what's typed", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field());
  await settle();
  menu.showAllPasswords(tabId);
  await settle();
  const everything = menu.rowsOfMenu(menu.vaultMenuOf(tabId)).filter((r) => r.kind === "login");
  assert.equal(everything.length, 100, "an empty search shows a page of logins, not the vault");
  menu.searchVaultMenu(tabId, "site2999");
  await settle();
  assert.deepEqual(menu.rowsOfMenu(menu.vaultMenuOf(tabId)).filter((r) => r.kind === "login").map((r) => r.item.id), ["2999"]);
  assert.ok(native.vaultFakes.searches.includes("site2999"));
  assert.ok(held().length <= 101 + 2);
});

test("locking a manager drops its logins from every cache at once", async () => {
  const { tabId } = await setup();
  await store.loadSiteItems("https://github.com");
  store.applyProviderState({ ...bitwarden, state: "locked" });
  assert.deepEqual(held(), []);
  menu.noteVaultField(tabId, field());
  await settle();
  const open = menu.vaultMenuOf(tabId);
  assert.ok(!open || menu.rowsOfMenu(open).every((r) => r.kind !== "login"));
});

test("Settings pages manager logins natively in site order and merges them with Ardia's own", async () => {
  native.vaultFakes.providers = [bitwarden];
  native.vaultFakes.items = Array.from({ length: 2500 }, (_, i) => login(i, `site${String(i).padStart(4, "0")}.example`));
  native.engineCalls.length = 0;
  const first = await fetchManagerRows("", { total: 0, items: [] }, 100);
  assert.equal(first.total, 2500);
  assert.equal(first.items.length, 100);
  const more = await fetchManagerRows("", first, 1300);
  assert.equal(more.items.length, 1300);
  assert.deepEqual(more.items.slice(0, 100), first.items, "growing keeps the rows already shown");
  assert.equal(new Set(more.items.map((i) => i.id)).size, 1300);
  assert.ok(native.engineCalls.filter((c) => c.verb === "listItems").length <= 1 + Math.ceil(1200 / ITEM_PAGE_MOST));
  const narrowed = await fetchManagerRows("site0042", { total: 0, items: [] }, 100);
  assert.deepEqual(narrowed.items.map((i) => i.id), ["42"]);
  const chrome = savedEntries([{ origin: "https://site0001.example", username: "ardia-own" }]);
  const merged = mergeSorted(chrome, loginEntries(first.items.slice(0, 3)));
  assert.deepEqual(merged.map((e) => e.username), ["user0", "ardia-own", "user1", "user2"]);
});
