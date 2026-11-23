import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const store = await import("./store.ts");
const menu = await import("./menu.ts");
const { noteVaultKey } = await import("./fill.ts");
const { loginLines } = await import("../../components/vaults/rowText.ts");
const { usePlugins } = await import("../plugins/store.ts");
usePlugins.setState({ scanned: true });
menu.startVaultMenus();

const S = () => useBrowser.getState();
const caps = { totp: true, save: true, selfHosted: true, masterPassword: true, touchID: false };
const bitwarden = { id: "bitwarden", name: "Bitwarden", state: "unlocked", capabilities: caps, install: { command: "", url: "" } };
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
const field = (over = {}) => ({ frameId: "f1", origin: "https://github.com", main: true, kind: "username", focused: true, clicked: true, rect: { x: 10, y: 100, width: 240, height: 28 }, formHasPassword: true, ...over });
const login = (id, site, username) => ({ provider: "bitwarden", id: String(id), title: site, username, urls: [`https://${site}`], hasTotp: false });
const logins = (tabId) => menu.rowsOfMenu(menu.vaultMenuOf(tabId)).filter((r) => r.kind === "login").map((r) => r.item.id);

async function setup() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://github.com/login" });
  const tabId = S().windows[w].tabIds[0];
  const told = [];
  webviews.set(tabId, { setVaultMenu: async (m) => void told.push(m.open), focus: async () => {}, discardVaultCapture: async () => {}, fillFromVault: async () => ({ filled: [] }) });
  native.vaultFakes.providers = [bitwarden];
  native.vaultFakes.items = [
    login("gh1", "github.com", "octo"),
    login("gh2", "gist.github.com", "octavia@example.com"),
    login("mail", "mail.example.org", "octo@example.org"),
    ...Array.from({ length: 2000 }, (_, i) => login(`n${i}`, `site${i}.example`, `user${i}`)),
  ];
  S().updateSettings({ vaultSuggestOnFocus: true });
  store.clearVaultIndex();
  await store.loadVaultProviders();
  await store.loadAllVaultItems(true);
  native.engineCalls.length = 0;
  menu.noteVaultField(tabId, field());
  await settle();
  return { tabId, told };
}

const type = (tabId, text) => noteVaultKey(tabId, text ? { frameId: "f1", key: "Typed", text } : { frameId: "f1", key: "Cleared" });

test("an empty field shows the site's logins in the order native recommends them", async () => {
  const { tabId } = await setup();
  assert.deepEqual(logins(tabId), ["gh1", "gh2"]);
  assert.ok(native.engineCalls.some((c) => c.verb === "recommend"), "the menu asks native for its recommendations");
});

test("typing in the page's field filters the menu across every login, with the first row selected", async () => {
  const { tabId } = await setup();
  type(tabId, "oct");
  await settle();
  const open = menu.vaultMenuOf(tabId);
  assert.ok(open, "typing keeps the menu");
  assert.deepEqual(new Set(logins(tabId)), new Set(["gh1", "gh2", "mail"]));
  assert.equal(open.selected, 0);
  assert.ok(native.vaultFakes.searches.includes("oct"));
  type(tabId, "octav");
  await settle();
  assert.deepEqual(logins(tabId), ["gh2"]);
  assert.equal(menu.vaultMenuOf(tabId).selected, 0);
});

test("when nothing matches the menu hides without closing, and comes back as the text matches again or the field empties", async () => {
  const { tabId, told } = await setup();
  type(tabId, "zzzz");
  await settle();
  assert.ok(menu.vaultMenuOf(tabId), "the menu is kept");
  assert.deepEqual(logins(tabId), []);
  assert.equal(told.at(-1), false, "the page hears the menu closed, so Enter and arrows stay its own");
  type(tabId, "user19");
  await settle();
  assert.equal(told.at(-1), true);
  assert.ok(logins(tabId).includes("n19"));
  type(tabId, "");
  await settle();
  assert.deepEqual(logins(tabId), ["gh1", "gh2"]);
});

test("a typed password never filters: typing there still dismisses the menu", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field({ kind: "password" }));
  await settle();
  noteVaultKey(tabId, { frameId: "f1", key: "Typed" });
  assert.equal(menu.vaultMenuOf(tabId), null);
});

test("a login suggested from a shared site says which site it is for", () => {
  const item = { provider: "bitwarden", id: "t", title: "YouTube", username: "sam", urls: ["https://youtube.com"], match: { tier: 1, reason: "shared", site: "youtube.com" } };
  assert.deepEqual(loginLines(item, "accounts.google.com"), { title: "sam", detail: "For youtube.com" });
  const brand = { provider: "bitwarden", id: "b", title: "Google", username: "sam", urls: [], match: { tier: 1, reason: "brand" } };
  assert.equal(loginLines(brand, "accounts.google.com").detail, "Google, no website");
});
