import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { touchScope } = await import("./touchScopes.ts");
const store = await import("./store.ts");
const menu = await import("./menu.ts");
const accounts = await import("./accounts.ts");
const codes = await import("./ardiaCodes.ts");
const { passwordProfileOfTab } = await import("./ardia.ts");
const { autofillCodeRow, startCodeAutofill } = await import("./fill.ts");
const { takeVaultCounts } = await import("../telemetry/vaultCounts.ts");

const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { usePlugins: pluginsForTest } = await import("../plugins/store.ts");
pluginsForTest.setState({ scanned: true });
setConsentPeriod(true, "ardiaCodes-test");
const S = () => useBrowser.getState();
const caps = { totp: true, save: true, selfHosted: false, masterPassword: false, touchID: false, addTotp: true };
const ardia = { id: "ardia", name: "Ardia", state: "unlocked", capabilities: caps, install: { command: "", url: "" } };
const octo = { provider: "ardia", id: "p\nocto", title: "github.com", username: "octo", urls: ["https://github.com"], hasTotp: false, profile: "Default" };
const coded = { ...octo, id: "p\ncoded", username: "coded", hasTotp: true };
const other = { ...octo, id: "q\nocto", profile: "Work" };
const calls = [];
const handle = {
  setVaultMenu: async () => undefined,
  fillFromVault: async (r) => (calls.push(r), { filled: ["otp"] }),
  focus: async () => undefined,
};
const settle = () => new Promise((r) => setTimeout(r, 0));
const field = (over = {}) => ({ frameId: "f1", origin: "https://github.com", main: true, kind: "otp", focused: true, rect: { x: 10, y: 100, width: 240, height: 28 }, formHasPassword: false, ...over });

async function setup() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://github.com/login" });
  const tabId = S().windows[w].tabIds[0];
  webviews.set(tabId, handle);
  native.vaultFakes.providers = [ardia];
  const profile = passwordProfileOfTab(tabId);
  native.vaultFakes.items = [{ ...octo, profile }, { ...coded, profile }, other];
  native.vaultFakes.addedTotps = [];
  native.vaultFakes.nextAddTotp = null;
  native.vaultFakes.removedTotps = [];
  native.vaultFakes.codeReads = [];
  native.vaultFakes.forgottenCodes = [];
  native.vaultFakes.nextCodeRead = { error: "none" };
  native.docs.delete(accounts.VAULT_ACCOUNTS_DOC);
  accounts.reloadVaultAccounts();
  S().updateSettings({ vaultSuggestOnFocus: true });
  calls.length = 0;
  store.clearVaultIndex();
  await store.loadVaultProviders();
  await store.loadAllVaultItems(true);
  takeVaultCounts();
  return { w, tabId };
}

test("a saved password finds its Ardia login by profile, site and username", () => {
  const items = [octo, coded, other];
  assert.equal(codes.ardiaLoginOf(items, "Default", "https://github.com/", "octo"), octo);
  assert.equal(codes.ardiaLoginOf(items, "Work", "https://GitHub.com", "octo"), other);
  assert.equal(codes.ardiaLoginOf(items, "Default", "https://github.com", "nobody"), null);
  assert.equal(codes.ardiaLoginOf(items, "Default", "https://github.com", "OCTO"), octo, "usernames compare ignoring case");
  assert.equal(codes.ardiaLoginOf(items, "Default", "https://gitlab.com", "octo"), null);
  assert.equal(codes.ardiaLoginOf([{ ...octo, provider: "bitwarden" }], "Default", "https://github.com", "octo"), null);
});

test("scanning the page is offered only when the front tab is the login's site", async () => {
  const { tabId } = await setup();
  assert.equal(codes.codePageTab(S(), "https://github.com"), tabId);
  assert.equal(codes.codePageTab(S(), "https://accounts.github.com"), tabId);
  assert.equal(codes.codePageTab(S(), "https://gitlab.com"), null);
  assert.deepEqual(codes.codeSetupChoices("https://github.com", null).map((c) => c.id), ["clipboard", "image"]);
  assert.deepEqual(codes.codeSetupChoices("https://github.com", tabId).map((c) => c.title), ["Paste Setup Key", "Choose QR Code Image…", "Scan QR Code on github.com"]);
});

test("a read that finds nothing says what to do, a declined panel says nothing", () => {
  assert.equal(codes.codeReadErrorText("declined", "image", "https://github.com"), null);
  assert.match(codes.codeReadErrorText("none", "clipboard", "https://github.com"), /Copy the setup key/);
  assert.match(codes.codeReadErrorText("none", "page", "https://github.com"), /github\.com/);
  assert.match(codes.codeReadErrorText("many", "image", "https://github.com"), /more than one/);
  assert.match(codes.codeReadErrorText("unreadable", "page", "https://github.com"), /front/);
});

test("nothing found stores nothing and counts a miss", async () => {
  await setup();
  native.vaultFakes.nextCodeRead = { error: "none" };
  const outcome = await codes.setUpArdiaCode(octo, "clipboard");
  assert.equal(outcome.ok, false);
  assert.deepEqual(native.vaultFakes.addedTotps, []);
  assert.deepEqual(native.vaultFakes.codeReads.map(({ source, origin, tabId }) => ({ source, origin, tabId })), [{ source: "clipboard", origin: "https://github.com", tabId: undefined }]);
  assert.equal(takeVaultCounts().vault_code_reads_missed, 1);
});

test("a declined owner check stays quiet and forgets the read code", async () => {
  await setup();
  native.vaultFakes.nextCodeRead = { token: "t9", issuer: "GitHub", account: "octo" };
  native.vaultFakes.nextAddTotp = { added: false, error: "declined" };
  const outcome = await codes.setUpArdiaCode(octo, "image");
  assert.deepEqual(outcome, { ok: false, error: null });
  assert.deepEqual(native.vaultFakes.forgottenCodes, ["t9"]);
  assert.equal(takeVaultCounts().vault_codes_set_up_image, 0);
});

test("a code read from the page is stored on that login and counted by method", async () => {
  const { tabId } = await setup();
  native.vaultFakes.nextCodeRead = { token: "t1", issuer: "GitHub", account: "octo" };
  const outcome = await codes.setUpArdiaCode(octo, "page", tabId);
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(native.vaultFakes.codeReads.map(({ source, origin, tabId }) => ({ source, origin, tabId })), [{ source: "page", origin: "https://github.com", tabId }]);
  assert.deepEqual(native.vaultFakes.addedTotps.map(({ provider, id, token }) => ({ provider, id, token })), [{ provider: "ardia", id: octo.id, token: "t1" }]);
  assert.equal(store.allVaultItems().find((i) => i.id === octo.id)?.hasTotp, true, "the list is reloaded");
  assert.equal(takeVaultCounts().vault_codes_set_up_page, 1);
});

test("removing a code reloads the login without one, a refusal says so", async () => {
  await setup();
  assert.deepEqual(await codes.removeArdiaCode(coded), { ok: true });
  assert.equal(store.allVaultItems().find((i) => i.id === coded.id)?.hasTotp, false);
  assert.equal(takeVaultCounts().vault_codes_removed, 1);
  native.vaultFakes.nextRemoveTotp = { removed: false, error: "declined" };
  assert.deepEqual(await codes.removeArdiaCode(coded), { ok: false, error: null });
  native.vaultFakes.nextRemoveTotp = { removed: false, error: "failed" };
  assert.match((await codes.removeArdiaCode(coded)).error, /Couldn't remove/);
});

test("renaming or deleting a saved password moves or drops its code", async () => {
  await setup();
  native.vaultFakes.loginChanges = [];
  await codes.ardiaLoginRenamed("Default", "https://github.com", "octo", "octo");
  await codes.ardiaLoginRenamed("Default", "https://github.com", "octo", "octocat");
  await codes.ardiaLoginDeleted("Default", "https://github.com", "octocat");
  assert.deepEqual(native.vaultFakes.loginChanges.map(({ profile, origin, username, to }) => ({ profile, origin, username, to })), [
    { profile: "Default", origin: "https://github.com", username: "octo", to: "octocat" },
    { profile: "Default", origin: "https://github.com", username: "octocat", to: null },
  ]);
});

test("the code planner fills only one pending code on a code field", () => {
  const pending = { key: "otp:a", kind: "otp", item: coded, pending: true, userChose: false };
  const listed = { ...pending, key: "otp:b", pending: false };
  const open = { field: "otp", hidden: false, busy: null, mode: "matches", onDemand: true };
  assert.equal(autofillCodeRow(open, [pending, listed]), pending);
  assert.equal(autofillCodeRow(open, [listed]), null, "a code the person didn't just sign in with waits for a choice");
  assert.equal(autofillCodeRow(open, [{ ...pending, userChose: true }]), null, "a code whose login doesn't match the page waits for a choice");
  assert.equal(autofillCodeRow(open, [pending, { ...pending, key: "otp:c" }]), null, "two pending codes wait for a choice");
  assert.equal(autofillCodeRow(open, [{ ...pending, item: { ...coded, hasTotp: undefined } }]), null, "an unknown code waits");
  assert.equal(autofillCodeRow({ ...open, field: "password" }, [pending]), null);
  assert.equal(autofillCodeRow({ ...open, busy: "otp:a" }, [pending]), null);
  assert.equal(autofillCodeRow({ ...open, hidden: true }, [pending]), null);
  assert.equal(autofillCodeRow({ ...open, mode: "search" }, [pending]), null);
  assert.equal(autofillCodeRow({ ...open, onDemand: false }, [pending]), null, "a field the page focused by itself waits for a click or key");
});

const pendingIn = (tabId, origin = "https://github.com") => [{ origin, tabId, provider: "ardia", id: coded.id, at: Date.now() }];

test("after a password fill, a click in the same tab's code field fills the code once", async () => {
  const { tabId } = await setup();
  const stop = startCodeAutofill();
  try {
    store.setPendingTotp(pendingIn(tabId));
    menu.noteVaultField(tabId, field());
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(calls.length, 0, "a focus the page made by itself fills nothing");
    menu.closeVaultMenu(tabId);
    menu.noteVaultField(tabId, field({ frameId: "f3", clicked: true }));
    for (let i = 0; i < 5 && !calls.length; i++) await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].fields, ["totp"]);
    assert.equal(calls[0].id, coded.id);
    assert.equal(calls[0].submit, false);
    assert.equal(calls[0].userChose, false, "the origin check still runs");
    assert.deepEqual(store.currentPendingTotp(), [], "the code is no longer pending");
    assert.equal(takeVaultCounts().vault_codes_autofilled, 1);
    menu.closeVaultMenu(tabId);
    menu.noteVaultField(tabId, field({ frameId: "f2", clicked: true }));
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(calls.length, 1, "clicking a code field again waits for a choice");
  } finally {
    stop();
  }
});

test("a pending code fills nothing on a sibling subdomain or in another tab", async () => {
  const { w, tabId } = await setup();
  const stop = startCodeAutofill();
  try {
    store.setPendingTotp(pendingIn(tabId, "https://login.github.com"));
    menu.noteVaultField(tabId, field({ clicked: true }));
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(calls.length, 0, "github.com isn't login.github.com");
    menu.closeVaultMenu(tabId);
    store.setPendingTotp(pendingIn("another-tab"));
    menu.noteVaultField(tabId, field({ frameId: "f4", clicked: true }));
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(calls.length, 0, "a code filled in another tab stays there");
    assert.ok(w);
  } finally {
    stop();
  }
});

const vaultCodes = await import("./codes.ts");

test("a code carries the next one, so the row never waits at the period's end", async () => {
  const code = { code: "111111", period: 30, expiresAt: 60_000, next: "222222" };
  assert.equal(vaultCodes.codeAt(code, 59_999), code);
  assert.deepEqual(vaultCodes.codeAt(code, 60_000), { code: "222222", period: 30, expiresAt: 90_000 });
  assert.equal(vaultCodes.codeAt(code, 90_000), null, "two periods on, it has to ask again");
  assert.equal(vaultCodes.codeAt({ ...code, next: undefined }, 60_000), null);
  await setup();
  vaultCodes.clearVaultCodes();
  const now = Date.now();
  vaultCodes.useVaultCodes.setState({ [`ardia/${coded.id}`]: { code: "111111", period: 30, expiresAt: now - 1, next: "222222" } }, true);
  const shown = vaultCodes.loadVaultCode(coded);
  assert.equal(vaultCodes.useVaultCodes.getState()[`ardia/${coded.id}`].code, "222222", "the next code shows at once, with no spinner");
  assert.equal((await shown).code, "222222");
  await settle();
  assert.equal(vaultCodes.useVaultCodes.getState()[`ardia/${coded.id}`].code, "123456", "then the fresh one replaces it");
});

const touch = await import("./touchID.ts");

test("a Touch ID grant is scoped to the selected login, its origin and its tab", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field({ kind: "password", formHasPassword: true, clicked: true }));
  await settle();
  const opened = menu.vaultMenuOf(tabId);
  assert.ok(opened);
  const at = menu.rowsOfMenu(opened).findIndex((r) => r.kind === "login");
  const shown = { ...opened, selected: at, touch: "ready" };
  const row = menu.rowsOfMenu(shown)[at];
  assert.equal(touch.touchScopeOf(tabId, shown), touchScope.fill(row.item.provider, row.item.id, opened.origin, tabId));
  assert.equal(touch.touchScopeOf(tabId, { ...shown, touch: "lockout" }), "", "no glyph, no grant");
  assert.equal(touch.touchScopeOf(tabId, { ...shown, selected: -1 }), "");
});
