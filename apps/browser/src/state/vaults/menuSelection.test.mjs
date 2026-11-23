import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const store = await import("./store.ts");
const menu = await import("./menu.ts");
const fill = await import("./fill.ts");
const touch = await import("./touchID.ts");
const { usePasskeys } = await import("./passkeyStore.ts");
const { usePlugins: pluginsForTest } = await import("../plugins/store.ts");
pluginsForTest.setState({ scanned: true });

const S = () => useBrowser.getState();
const caps = { totp: true, save: true, selfHosted: true, masterPassword: true, touchID: false };
const provider = (state) => ({ id: "bitwarden", name: "Bitwarden", state, capabilities: caps, install: { command: "brew install bitwarden-cli", url: "" } });
const settle = () => new Promise((r) => setTimeout(r, 0));
const field = (origin, over = {}) => ({ frameId: "f1", origin, main: true, kind: "username", focused: true, rect: { x: 10, y: 100, width: 240, height: 28 }, formHasPassword: true, ...over });

async function setup({ state = "unlocked", items, page = "https://github.com" }) {
  S().hydrate({});
  const w = S().createWindow({ url: `${page}/login` });
  const tabId = S().windows[w].tabIds[0];
  const fills = [];
  webviews.set(tabId, {
    setVaultMenu: async () => {},
    focus: async () => {},
    discardVaultCapture: async () => {},
    fillFromVault: async (r) => (fills.push(r), { filled: ["username", "password"] }),
  });
  native.vaultFakes.providers = [provider(state)];
  native.vaultFakes.items = items;
  S().updateSettings({ vaultSuggestOnFocus: true, vaultAskBeforeFilling: false });
  usePasskeys.setState({ offers: {}, sheets: {} });
  store.clearVaultIndex();
  await store.loadVaultProviders();
  await store.loadAllVaultItems(true);
  await store.loadSiteItems(page);
  return { tabId, fills };
}

async function openMenu(tabId, origin, over) {
  menu.noteVaultField(tabId, field(origin, { clicked: true, ...over }));
  await settle();
  return menu.vaultMenuOf(tabId);
}

const selectedRow = (tabId) => {
  const now = menu.vaultMenuOf(tabId);
  return menu.rowsOfMenu(now)[now.selected];
};

test("a passkey offer landing under an open menu keeps the highlight on the same login", async () => {
  const alice = { provider: "bitwarden", id: "a", title: "GitHub", username: "alice", urls: ["https://github.com"] };
  const { tabId, fills } = await setup({ items: [alice] });
  const stop = menu.startVaultMenus();
  try {
    const opened = await openMenu(tabId, "https://github.com", { webauthn: true });
    assert.equal(menu.rowsOfMenu(opened)[opened.selected]?.key, "login:bitwarden/a");
    usePasskeys.setState({ offers: { [tabId]: { requestId: "r1", tabId, origin: "https://github.com", rpId: "github.com", passkeys: [{ id: "pk", provider: "ardia", userName: "bob", displayName: "Bob" }] } } });
    menu.patchVaultMenu(tabId, {});
    assert.equal(selectedRow(tabId)?.key, "login:bitwarden/a");
    fill.stepVaultMenu(tabId, "Enter");
    await settle();
    assert.deepEqual(fills.map((f) => f.id), ["a"]);
  } finally {
    stop();
  }
});

test("Enter acts on the highlighted row after a pending code row expires", async () => {
  const site = { provider: "bitwarden", id: "s", title: "GitHub", username: "octo", urls: ["https://github.com"], hasTotp: true };
  const other = { provider: "bitwarden", id: "o", title: "GitHub", username: "work", urls: ["https://github.com"], hasTotp: true };
  const { tabId } = await setup({ items: [site, other] });
  const at = Date.now();
  store.setPendingTotp([{ origin: "https://github.com", tabId, provider: "bitwarden", id: "o", at }]);
  const opened = await openMenu(tabId, "https://github.com", { kind: "otp" });
  const keyBefore = menu.rowsOfMenu(opened)[opened.selected]?.key;
  const realNow = Date.now;
  Date.now = () => at + 4 * 60_000;
  try {
    menu.restVaultMenu(tabId);
    assert.equal(selectedRow(tabId)?.key, keyBefore);
  } finally {
    Date.now = realNow;
  }
});

test("unlocking from the menu doesn't fill a login saved for another subdomain", async () => {
  const mail = { provider: "bitwarden", id: "m", title: "Mail", username: "alice", urls: ["https://mail.example.com"] };
  const { tabId, fills } = await setup({ state: "locked", items: [mail], page: "https://shop.example.com" });
  const opened = await openMenu(tabId, "https://shop.example.com");
  const unlock = menu.rowsOfMenu(opened).findIndex((r) => r.kind === "unlock");
  assert.ok(unlock >= 0);
  menu.selectVaultRow(tabId, unlock);
  fill.activateVaultRow(tabId, menu.rowsOfMenu(opened)[unlock], fill.BY_TOUCH_ID);
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(fills, []);
  const now = menu.vaultMenuOf(tabId);
  assert.ok(now, "the menu stays open");
  assert.equal(selectedRow(tabId)?.key, "login:bitwarden/m");
  assert.equal(now.touch, "off");
});

test("unlocking from the menu doesn't pick between two logins for the site", async () => {
  const one = { provider: "bitwarden", id: "1", title: "GitHub", username: "alice", urls: ["https://github.com"] };
  const two = { provider: "bitwarden", id: "2", title: "GitHub", username: "bob", urls: ["https://github.com"] };
  const { tabId, fills } = await setup({ state: "locked", items: [one, two] });
  const opened = await openMenu(tabId, "https://github.com");
  const row = menu.rowsOfMenu(opened).find((r) => r.kind === "unlock");
  fill.activateVaultRow(tabId, row);
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(fills, []);
  assert.ok(menu.vaultMenuOf(tabId));
});

test("unlocking from the menu still fills the one login saved for this site", async () => {
  const one = { provider: "bitwarden", id: "1", title: "GitHub", username: "alice", urls: ["https://github.com"] };
  const { tabId, fills } = await setup({ state: "locked", items: [one] });
  const opened = await openMenu(tabId, "https://github.com");
  fill.activateVaultRow(tabId, menu.rowsOfMenu(opened).find((r) => r.kind === "unlock"));
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(fills.map((f) => f.id), ["1"]);
});

test("a Touch ID grant fills the row the menu highlights, not one a passkey offer pushed into its place", async () => {
  const alice = { provider: "bitwarden", id: "a", title: "GitHub", username: "alice", urls: ["https://github.com"] };
  const { tabId, fills } = await setup({ items: [alice] });
  S().updateSettings({ vaultAskBeforeFilling: true });
  const opened = await openMenu(tabId, "https://github.com", { webauthn: true });
  touch.armVaultTouchID(tabId, opened.seq);
  usePasskeys.setState({ offers: { [tabId]: { requestId: "r1", tabId, origin: "https://github.com", rpId: "github.com", passkeys: [{ id: "pk", provider: "ardia", userName: "bob", displayName: "Bob" }] } } });
  touch.grantVaultTouch(tabId, opened.seq);
  await settle();
  assert.deepEqual(fills.map((f) => f.id), ["a"]);
});

test("the search menu closes when the page field blurs and nothing in the menu took focus", async () => {
  const alice = { provider: "bitwarden", id: "a", title: "GitHub", username: "alice", urls: ["https://github.com"] };
  const { tabId } = await setup({ items: [alice] });
  await openMenu(tabId, "https://github.com");
  menu.showAllPasswords(tabId);
  menu.noteVaultSearchFocus(tabId, false);
  menu.noteVaultField(tabId, field("https://github.com", { focused: false }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(menu.vaultMenuOf(tabId), null);
});

test("the search menu stays while its search field has focus", async () => {
  const alice = { provider: "bitwarden", id: "a", title: "GitHub", username: "alice", urls: ["https://github.com"] };
  const { tabId } = await setup({ items: [alice] });
  await openMenu(tabId, "https://github.com");
  menu.showAllPasswords(tabId);
  menu.noteVaultSearchFocus(tabId, true);
  menu.noteVaultField(tabId, field("https://github.com", { focused: false }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(menu.vaultMenuOf(tabId)?.mode, "search");
});

test("Escape from the page closes the search menu", async () => {
  const alice = { provider: "bitwarden", id: "a", title: "GitHub", username: "alice", urls: ["https://github.com"] };
  const { tabId } = await setup({ items: [alice] });
  const opened = await openMenu(tabId, "https://github.com");
  menu.showAllPasswords(tabId);
  fill.noteVaultKey(tabId, { frameId: opened.frameId, key: "Escape" });
  assert.equal(menu.vaultMenuOf(tabId), null);
});

test("a page handle that answers nothing leaves an error in the menu instead of throwing", async () => {
  const alice = { provider: "bitwarden", id: "a", title: "GitHub", username: "alice", urls: ["https://github.com"] };
  const { tabId } = await setup({ items: [alice] });
  const opened = await openMenu(tabId, "https://github.com");
  webviews.set(tabId, { setVaultMenu: async () => {}, focus: async () => {}, discardVaultCapture: async () => {}, fillFromVault: async () => null, stageVaultPassword: async () => null });
  fill.activateVaultRow(tabId, menu.rowsOfMenu(opened)[opened.selected]);
  for (let i = 0; i < 3; i++) await settle();
  assert.equal(menu.vaultMenuOf(tabId)?.error, "Couldn't fill this login. Try again.");
  const { stageOfferPassword } = await import("./savePassword.ts");
  assert.deepEqual(await stageOfferPassword(tabId, "https://github.com"), { token: "", length: 0 });
});

test("a login picked by hand on a look-alike site never arms an automatic code fill", async () => {
  const real = { provider: "bitwarden", id: "gh", title: "GitHub", username: "octo", urls: ["https://github.com"], hasTotp: true };
  const { tabId, fills } = await setup({ items: [real], page: "https://githuh.com" });
  store.setPendingTotp([]);
  const opened = await openMenu(tabId, "https://githuh.com", { kind: "password" });
  menu.showAllPasswords(tabId);
  await settle();
  const row = menu.rowsOfMenu(menu.vaultMenuOf(tabId)).find((r) => r.kind === "login");
  fill.activateVaultRow(tabId, row);
  for (let i = 0; i < 3; i++) await settle();
  assert.deepEqual(fills.map((f) => f.id), ["gh"], "the explicit pick still fills");
  assert.deepEqual(store.currentPendingTotp(), []);
  assert.ok(opened);
});

test("a pending code for a site the login doesn't match isn't filled on its own", () => {
  const real = { provider: "bitwarden", id: "gh", title: "GitHub", username: "octo", urls: ["https://github.com"], hasTotp: true };
  const row = { key: "otp:bitwarden/gh", kind: "otp", item: real, pending: true, userChose: true };
  const menuState = { field: "otp", onDemand: true, hidden: false, busy: null, mode: "matches" };
  assert.equal(fill.autofillCodeRow(menuState, [row]), null);
  assert.equal(fill.needsExplicitPick(row), true);
  assert.ok(fill.autofillCodeRow(menuState, [{ ...row, userChose: false }]));
});
