import assert from "node:assert/strict";
import { after, test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { pageOf } = await import("../tabs/pageState.ts");
const { showPasswordPrompt } = await import("../site/prompts.ts");
const store = await import("./store.ts");
const menu = await import("./menu.ts");
const dropdowns = await import("./menuDropdown.ts");
const { noteVaultKey } = await import("./fill.ts");
const offers = await import("./saveOffer.ts");
const { pendingFor } = await import("./pendingTotp.ts");
const { vaultBarActions } = await import("./barActions.ts");
const touch = await import("./touchID.ts");
const accounts = await import("./accounts.ts");
const fillModule = await import("./fill.ts");
const codes = await import("./codes.ts");
const sync = await import("./sync.ts");
const { takeVaultCounts } = await import("../telemetry/vaultCounts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { usePlugins: pluginsForTest } = await import("../plugins/store.ts");
pluginsForTest.setState({ scanned: true });
setConsentPeriod(true, "vaultFlow-test");

const S = () => useBrowser.getState();
const caps = { totp: true, save: true, selfHosted: true, masterPassword: true, touchID: false };
const provider = (state) => ({ id: "bitwarden", name: "Bitwarden", state, capabilities: caps, install: { command: "brew install bitwarden-cli", url: "" } });
const login = { provider: "bitwarden", id: "gh", title: "GitHub", username: "octo", urls: ["https://github.com"], hasTotp: true };
const calls = [];
const handle = {
  setVaultMenu: async (r) => void calls.push(["menu", r.open, r.highlighted]),
  fillFromVault: async (r) => (calls.push(["fill", r]), { filled: ["username", "password"] }),
  fillGeneratedPassword: async () => ({ filled: ["newPassword"] }),
  saveToVault: async (r) => (calls.push(["save", r]), { saved: true }),
  updateVaultPassword: async (r) => (calls.push(["update", r]), handle.updateAnswer ?? { edited: true, item: login }),
  discardVaultCapture: async (r) => void calls.push(["discard", r.origin]),
  focus: async () => void calls.push(["focus"]),
};
const field = (over = {}) => ({ frameId: "f1", origin: "https://github.com", main: true, kind: "password", focused: true, rect: { x: 10, y: 100, width: 240, height: 28 }, formHasPassword: true, ...over });
const settle = () => new Promise((r) => setTimeout(r, 0));

async function setup(state = "unlocked") {
  S().hydrate({});
  const w = S().createWindow({ url: "https://github.com/login" });
  const tabId = S().windows[w].tabIds[0];
  webviews.set(tabId, handle);
  native.vaultFakes.providers = [provider(state)];
  native.vaultFakes.items = [login];
  native.vaultFakes.copied.length = 0;
  native.docs.delete(accounts.VAULT_ACCOUNTS_DOC);
  accounts.reloadVaultAccounts();
  S().updateSettings({ vaultSuggestOnFocus: true, vaultSaveOffer: true, vaultAutoSave: true, vaultSaveTarget: "" });
  calls.length = 0;
  store.clearVaultIndex();
  await store.loadVaultProviders();
  await store.loadAllVaultItems(true);
  await store.loadSiteItems("https://github.com");
  return { w, tabId };
}

const held = () => {
  const s = store.useVaults.getState();
  return [...Object.values(s.sites), ...Object.values(s.searches)].flat();
};

const second = { provider: "bitwarden", id: "work", title: "GitHub", username: "octo-work", urls: ["https://github.com"], hasTotp: false };
const openMenuNow = async (tabId, over = {}) => {
  menu.noteVaultField(tabId, field(over));
  await settle();
  return menu.vaultMenuOf(tabId);
};
const fills = () => calls.filter((c) => c[0] === "fill").map((c) => c[1]);
const saves = () => calls.filter((c) => c[0] === "save").map((c) => c[1]);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function withHandle(patch, run) {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, handle[k]]));
  Object.assign(handle, patch);
  try {
    await run();
  } finally {
    Object.assign(handle, saved);
  }
}

const submitted = (over = {}) => ({ frameId: "f1", origin: "https://github.com", username: "", usernameFrom: over.username ? "form" : "", trusted: true, newPassword: false, generated: false, ...over });
const offerOf = (tabId) => offers.useVaultSaveOffers.getState()[tabId] ?? null;

after(() => {
  offers.forgetClosedVaultSaves({});
  for (const tabId of Object.keys(offers.useVaultSaveOffers.getState())) offers.dismissVaultOffer(tabId);
});

test("nothing opens on an insecure page or with suggestions turned off", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field({ origin: "http://github.com" }));
  await settle();
  assert.equal(menu.vaultMenuOf(tabId), null);
  S().updateSettings({ vaultSuggestOnFocus: false });
  menu.noteVaultField(tabId, field({ frameId: "f2" }));
  await settle();
  assert.equal(menu.vaultMenuOf(tabId), null);
  S().updateSettings({ vaultSuggestOnFocus: true });
});

test("a field the page focuses by itself opens the menu as a focus by the person does, and counts it", async () => {
  const { tabId } = await setup();
  takeVaultCounts();
  menu.noteVaultField(tabId, field({ auto: true }));
  await settle();
  assert.equal(menu.vaultMenuOf(tabId)?.field, "password");
  assert.equal(menu.vaultMenuOf(tabId)?.onDemand, false);
  assert.deepEqual(calls.at(-1), ["menu", true, true]);
  const counted = takeVaultCounts();
  assert.equal(counted.vault_menu_opens_on_autofocus, 1);
  assert.equal(counted.vault_menu_opens_from_icon, 0);
  menu.closeVaultMenu(tabId);
  menu.noteVaultField(tabId, field({ focused: false, rect: null }));
  menu.noteVaultField(tabId, field());
  await settle();
  assert.ok(menu.vaultMenuOf(tabId));
  assert.equal(takeVaultCounts().vault_menu_opens_on_autofocus, 0, "a focus the person made isn't counted");
  menu.closeVaultMenu(tabId);
});

test("a page that keeps refocusing its field neither flickers the menu nor brings it back after Escape", async () => {
  const { tabId } = await setup();
  const stop = menu.startVaultMenus();
  try {
    menu.noteVaultField(tabId, field({ auto: true }));
    await settle();
    const opened = menu.vaultMenuOf(tabId);
    assert.ok(opened);
    menu.noteVaultField(tabId, field({ focused: false, rect: null }));
    menu.noteVaultField(tabId, field({ auto: true }));
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(menu.vaultMenuOf(tabId)?.seq, opened.seq, "a quick blur and refocus keeps the same menu open");
    menu.noteVaultField(tabId, field({ focused: false, rect: null }));
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(menu.vaultMenuOf(tabId), null, "a blur that lasts closes it");
    menu.noteVaultField(tabId, field({ auto: true }));
    await settle();
    assert.equal(menu.vaultMenuOf(tabId), null, "and the page focusing the same field again doesn't reopen it");
    menu.noteVaultField(tabId, field({ clicked: true }));
    await settle();
    assert.ok(menu.vaultMenuOf(tabId), "a click does");
    noteVaultKey(tabId, { frameId: "f1", key: "Escape" });
    for (let i = 0; i < 3; i++) {
      menu.noteVaultField(tabId, field({ focused: false, rect: null }));
      menu.noteVaultField(tabId, field({ auto: true }));
      await settle();
      menu.offerToFocusedField(tabId);
      await settle();
      assert.equal(menu.vaultMenuOf(tabId), null, `refocus ${i + 1} after Escape stays closed`);
    }
    menu.noteVaultField(tabId, field({ kind: "username", auto: true }));
    await settle();
    assert.equal(menu.vaultMenuOf(tabId)?.field, "username", "the page moving focus to another field offers there");
  } finally {
    stop();
    menu.closeVaultMenu(tabId);
  }
});

test("a focus that couldn't be offered yet is offered when its next report can be, even a refocus by the page", async () => {
  const { tabId } = await setup();
  const stop = menu.startVaultMenus();
  try {
    menu.noteVaultField(tabId, field({ auto: true, rect: null }));
    await settle();
    assert.equal(menu.vaultMenuOf(tabId), null, "no rect while the page animates in");
    menu.noteVaultField(tabId, field({ auto: true }));
    await settle();
    assert.equal(menu.vaultMenuOf(tabId)?.field, "password", "the same focus with a rect opens it");
    menu.closeVaultMenu(tabId);
    menu.noteVaultField(tabId, field({ auto: true }));
    await settle();
    assert.equal(menu.vaultMenuOf(tabId), null, "once shown for this focus, its reports don't reopen it");

    menu.noteVaultField(tabId, field({ kind: "username", auto: true, rect: null }));
    menu.noteVaultField(tabId, field({ kind: "username", focused: false, rect: null }));
    menu.noteVaultField(tabId, field({ kind: "username", auto: true }));
    await settle();
    assert.equal(menu.vaultMenuOf(tabId)?.field, "username", "a script refocus of a focus that was never offered offers it");
  } finally {
    stop();
    menu.closeVaultMenu(tabId);
  }
});

test("a focused field whose logins arrive late opens the menu when they land, without a new focus", async () => {
  const { tabId } = await setup();
  const stop = menu.startVaultMenus();
  try {
    native.vaultFakes.items = [];
    store.clearVaultIndex();
    await store.loadAllVaultItems(true);
    await store.loadSiteItems("https://github.com");
    menu.noteVaultField(tabId, field({ auto: true }));
    await settle();
    await settle();
    assert.equal(menu.vaultMenuOf(tabId), null, "nothing to offer yet");
    menu.noteVaultField(tabId, field({ auto: true, rect: { x: 10, y: 101, width: 240, height: 28 } }));
    await settle();
    assert.equal(menu.vaultMenuOf(tabId), null, "a rect update for the same focus doesn't ask again");
    native.vaultFakes.items = [login];
    await store.loadAllVaultItems(true);
    await store.loadSiteItems("https://github.com");
    await settle();
    assert.equal(menu.vaultMenuOf(tabId)?.field, "password");
    menu.closeVaultMenu(tabId);
    await store.loadSiteItems("https://github.com");
    native.vaultFakes.items = [login, second];
    await store.loadAllVaultItems(true);
    await store.loadSiteItems("https://github.com");
    await settle();
    assert.equal(menu.vaultMenuOf(tabId), null, "a menu already shown for this focus isn't brought back by new logins");
  } finally {
    stop();
    menu.closeVaultMenu(tabId);
  }
});

test("a field focused in a background tab waits until that tab is shown", async () => {
  const { w, tabId } = await setup();
  const stop = menu.startVaultMenus();
  try {
    const back = S().newTab(w, { url: "https://github.com/login", background: true });
    webviews.set(back, handle);
    menu.noteVaultField(back, field({ auto: true }));
    await settle();
    assert.equal(menu.vaultMenuOf(back), null);
    menu.offerToFocusedField(back);
    await settle();
    assert.equal(menu.vaultMenuOf(back), null, "nor when a manager unlocks while it's hidden");
    S().activate(back);
    menu.offerToFocusedField(back);
    await settle();
    assert.equal(menu.vaultMenuOf(back)?.field, "password", "shown, it offers the field that's still focused");
    S().activate(tabId);
    await settle();
    assert.equal(menu.vaultMenuOf(back), null);
  } finally {
    stop();
  }
});

test("focusing a login field with a match opens the menu on its first login and tells the page", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field());
  await settle();
  assert.equal(menu.vaultMenuOf(tabId)?.field, "password");
  assert.equal(menu.vaultMenuOf(tabId)?.selected, 0);
  assert.deepEqual(calls.at(-1), ["menu", true, true], "the page hands Enter to the menu");
  menu.noteVaultField(tabId, field({ rect: { x: 10, y: 60, width: 240, height: 28 } }));
  assert.equal(menu.vaultMenuOf(tabId)?.rect.y, 60, "rect updates follow the field");
});

test("a slow or hung item refresh never holds back the menu for logins already listed", async (t) => {
  const { tabId } = await setup();
  let release;
  native.vaultFakes.itemsGate = new Promise((r) => (release = r));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(60_000);
  try {
    menu.noteVaultField(tabId, field());
    await settle();
    assert.equal(menu.vaultMenuOf(tabId)?.field, "password", "the menu opens from the listed logins while the refresh runs");
  } finally {
    native.vaultFakes.itemsGate = null;
    release();
    t.mock.timers.reset();
    await settle();
  }
});

test("enter fills the highlighted login into the reporting frame, and remembers its code", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field());
  await settle();
  noteVaultKey(tabId, { frameId: "other", key: "ArrowDown" });
  assert.equal(menu.vaultMenuOf(tabId)?.selected, 0, "keys from another frame are ignored");
  noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
  await settle();
  const fill = calls.find((c) => c[0] === "fill")[1];
  assert.deepEqual({ ...fill }, { frameId: "f1", origin: "https://github.com", provider: "bitwarden", id: "gh", fields: ["username", "password"], userChose: false, submit: false });
  assert.equal(menu.vaultMenuOf(tabId), null);
  assert.equal(pendingFor(store.currentPendingTotp(), "https://github.com", tabId, Date.now())?.id, "gh");
});

test("declining Touch ID or the Mac password keeps the menu open with no error and fills nothing", async () => {
  const { tabId } = await setup();
  const fill = handle.fillFromVault;
  handle.fillFromVault = async (r) => (calls.push(["fill", r]), { filled: [], error: "notAuthorized" });
  try {
    menu.noteVaultField(tabId, field());
    await settle();
    noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
    await settle();
    assert.equal(calls.filter((c) => c[0] === "fill").length, 1, "Return went to the login");
    const open = menu.vaultMenuOf(tabId);
    assert.ok(open, "the menu stays up to try again");
    assert.equal(open.error, null);
    assert.equal(open.busy, null);
    assert.equal(pendingFor(store.currentPendingTotp(), "https://github.com", tabId, Date.now()), null, "no code is queued for a login that wasn't filled");
  } finally {
    handle.fillFromVault = fill;
  }
});

test("Escape keeps the menu away when the same field gets focus back, until it's clicked", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field());
  await settle();
  noteVaultKey(tabId, { frameId: "f1", key: "Escape" });
  assert.equal(menu.vaultMenuOf(tabId), null);
  menu.noteVaultField(tabId, field({ focused: false, rect: null }));
  menu.noteVaultField(tabId, field());
  await settle();
  assert.equal(menu.vaultMenuOf(tabId), null, "coming back from another app doesn't reopen it");
  menu.noteVaultField(tabId, field({ clicked: true }));
  await settle();
  assert.ok(menu.vaultMenuOf(tabId), "a click on the field brings it back");
});

test("a field focused again while the menu is open hands the keys back to the menu", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field());
  await settle();
  noteVaultKey(tabId, { frameId: "f1", key: "ArrowDown" });
  calls.length = 0;
  menu.noteVaultField(tabId, field({ focused: false, rect: null }));
  menu.noteVaultField(tabId, field());
  assert.deepEqual(calls.at(-1), ["menu", true, true]);
});

test("a field already focused gets the menu once its manager unlocks", async () => {
  const { tabId } = await setup("locked");
  native.vaultFakes.items = [login];
  menu.noteVaultField(tabId, field({ kind: "username" }));
  await settle();
  menu.closeVaultMenu(tabId);
  const stop = menu.startVaultMenus();
  try {
    native.vaultFakes.providers = [provider("unlocked")];
    await store.loadVaultProviders();
    await settle();
    await settle();
    assert.ok(menu.vaultMenuOf(tabId), "the menu offers the login without a refocus");
  } finally {
    stop();
  }
});

test("leaving the menu keeps the highlight where the pointer left it, and keys move on from there", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field());
  await settle();
  menu.hoverVaultMenu(tabId, true);
  menu.selectVaultRow(tabId, 1);
  assert.equal(menu.vaultMenuOf(tabId)?.selected, 1, "hovering Other Passwords highlights it");
  menu.hoverVaultMenu(tabId, false);
  assert.equal(menu.vaultMenuOf(tabId)?.selected, 1);
  assert.equal(menu.vaultMenuOf(tabId)?.hovered, false);
  noteVaultKey(tabId, { frameId: "f1", key: "ArrowUp" });
  assert.equal(menu.vaultMenuOf(tabId)?.selected, 0, "ArrowUp moves from the kept row");
  menu.closeVaultMenu(tabId);
});

test("with Selection Returns to the Top on, leaving the menu puts the highlight back on the first login", async () => {
  const { tabId } = await setup();
  S().updateSettings({ vaultMenuSelectionReturns: true });
  try {
    menu.noteVaultField(tabId, field());
    await settle();
    menu.hoverVaultMenu(tabId, true);
    menu.selectVaultRow(tabId, 1);
    menu.hoverVaultMenu(tabId, false);
    assert.equal(menu.vaultMenuOf(tabId)?.selected, 0);
    assert.deepEqual(calls.at(-1), ["menu", true, true]);
  } finally {
    S().updateSettings({ vaultMenuSelectionReturns: false });
    menu.closeVaultMenu(tabId);
  }
});

test("a touch fills the selected login, and nothing once it's disarmed", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field());
  await settle();
  const seq = menu.vaultMenuOf(tabId).seq;
  touch.armVaultTouchID(tabId, null);
  assert.equal(touch.grantVaultTouch(tabId, seq), false);
  touch.armVaultTouchID(tabId, seq);
  assert.equal(touch.grantVaultTouch("another-tab", seq), false, "a grant for another tab fills nothing here");
  assert.equal(touch.grantVaultTouch(tabId, seq + 1), false, "nor one for another menu");
  assert.equal(touch.grantVaultTouch(tabId, seq), true);
  await settle();
  assert.equal(calls.find((c) => c[0] === "fill")?.[1].id, "gh");
});

test("a touch fills and submits the sibling login it shows on, as the person's choice", async () => {
  const { tabId } = await setup();
  native.vaultFakes.items = [{ ...login, id: "gist", urls: ["https://gist.github.com"] }];
  await store.loadAllVaultItems(true);
  menu.noteVaultField(tabId, field({ origin: "https://mail.github.com" }));
  await settle();
  const open = menu.vaultMenuOf(tabId);
  assert.ok(open, "the sibling login is offered");
  const rows = menu.rowsOfMenu(open);
  const at = rows.findIndex((r) => r.kind === "login");
  assert.equal(rows[at].userChose, true);
  assert.equal(open.selected, at, "with no login for this site, the menu rests on the sibling");
  touch.armVaultTouchID(tabId, open.seq);
  assert.equal(touch.grantVaultTouch(tabId, open.seq), true);
  await settle();
  const filled = calls.find((c) => c[0] === "fill");
  assert.equal(filled?.[1].id, "gist");
  assert.equal(filled?.[1].userChose, true);
  assert.equal(filled?.[1].submit, true, "a touch submits");
});

test("a trusted Return from the page fills a sibling login as an explicit choice", async () => {
  const { tabId } = await setup();
  native.vaultFakes.items = [{ ...login, id: "gist", urls: ["https://gist.github.com"] }];
  await store.loadAllVaultItems(true);
  menu.noteVaultField(tabId, field({ origin: "https://mail.github.com" }));
  await settle();
  noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
  await settle();
  const filled = calls.find((c) => c[0] === "fill");
  assert.equal(filled?.[1].id, "gist", "Return fills it");
  assert.equal(filled?.[1].userChose, true);
});

test("only rows that fill on their own can be filled by a touch", () => {
  const rows = [{ key: "username:x", kind: "username", item: login }];
  assert.equal(fillModule.needsExplicitPick(rows[0]), true);
  assert.equal(fillModule.needsExplicitPick({ key: "login:x", kind: "login", item: login, userChose: false }), false);
  assert.equal(fillModule.needsExplicitPick({ key: "otp:x", kind: "otp", item: login, pending: true, userChose: false }), false, "the code for the login just filled still fills");
  assert.equal(fillModule.needsExplicitPick({ key: "otp:x", kind: "otp", item: login, pending: true, userChose: true }), true, "a code whose login doesn't match the page waits for a pick");
});

test("enter with nothing highlighted closes the menu so the form can submit", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field());
  await settle();
  noteVaultKey(tabId, { frameId: "f1", key: "ArrowDown" });
  noteVaultKey(tabId, { frameId: "f1", key: "ArrowUp" });
  assert.deepEqual(calls.at(-1), ["menu", true, true]);
  menu.selectVaultRow(tabId, -1);
  assert.deepEqual(calls.at(-1), ["menu", true, false], "clearing the highlight lets the page keep Enter");
  noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
  assert.equal(menu.vaultMenuOf(tabId), null);
  assert.deepEqual(calls.at(-1), ["menu", false, false]);
  assert.equal(calls.some((c) => c[0] === "fill"), false);
});

test("Chrome's own dropdown never closes a menu that has logins to fill", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field());
  await settle();
  dropdowns.noteAutofillSuggestions(tabId, 2);
  assert.ok(menu.vaultMenuOf(tabId), "the login row keeps our menu up");
  menu.closeVaultMenu(tabId);
});

const dropdownClaims = (tabId) => native.vaultFakes.dropdownClaims.filter((c) => !tabId || c.tabId === tabId).map((c) => c.kinds.join(","));
function startMenusAndDropdowns() {
  const stops = [menu.startVaultMenus(), dropdowns.startVaultMenuDropdowns()];
  return () => stops.forEach((stop) => stop());
}

test("Chrome's login or form-history dropdown under a menu with only unlock rows closes, and the menu stays", async () => {
  const { tabId } = await setup("locked");
  const stop = startMenusAndDropdowns();
  try {
    menu.noteVaultField(tabId, field({ kind: "username" }));
    await settle();
    assert.ok(menu.vaultMenuOf(tabId));
    native.vaultFakes.dropdownClaims.length = 0;
    takeVaultCounts();
    native.vaultFakes.dropdownShowing = ["history"];
    dropdowns.noteAutofillSuggestions(tabId, 1, ["history"], false);
    await settle();
    assert.ok(menu.vaultMenuOf(tabId), "Ardia's menu owns a login field");
    assert.equal(dropdownClaims()[0], "login,history,address,card,other", "Chrome's dropdown is closed");
    assert.equal(dropdownClaims().at(-1), "history,login,passkey", "then the menu's own claim comes back");
    dropdowns.noteAutofillSuggestions(tabId, 1, ["login"], true);
    const counts = takeVaultCounts();
    assert.equal(counts.vault_chrome_dropdowns_hidden, 2);
    assert.equal(counts.vault_menu_yields_to_chrome, 0);
  } finally {
    stop();
    menu.closeVaultMenu(tabId);
  }
});

test("typing a search in the menu claims Chrome's logins once, for the page's own matches", async () => {
  const { tabId } = await setup();
  native.vaultFakes.items = [login, { provider: "bitwarden", id: "other", title: "Example", username: "someone-else", urls: ["https://example.com"], hasTotp: false }];
  await store.loadAllVaultItems(true);
  const stop = startMenusAndDropdowns();
  try {
    menu.noteVaultField(tabId, field({ kind: "username" }));
    await settle();
    menu.showAllPasswords(tabId);
    await settle();
    native.vaultFakes.dropdownClaims.length = 0;
    for (const query of ["s", "so", "som", "some"]) {
      menu.searchVaultMenu(tabId, query);
      await settle();
    }
    assert.deepEqual(dropdownClaims(tabId), [], "the claim stays what the page's matches made it");
  } finally {
    menu.closeVaultMenu(tabId);
    await settle();
    stop();
  }
});

test("a menu that opens over Chrome's login dropdown closes it, and closing the menu gives Chrome the field back", async () => {
  const { tabId } = await setup("locked");
  const stop = startMenusAndDropdowns();
  try {
    native.vaultFakes.dropdownClaims.length = 0;
    native.vaultFakes.dropdownShowing = ["login"];
    takeVaultCounts();
    menu.noteVaultField(tabId, field());
    await settle();
    await settle();
    assert.deepEqual(dropdownClaims(tabId), ["history", "history,login,passkey"], "the focused login field claims form history, then the menu claims the rest");
    assert.deepEqual(native.vaultFakes.dropdownShowing, [], "a login dropdown with no saved logins in it went away");
    assert.ok(menu.vaultMenuOf(tabId));
    assert.equal(takeVaultCounts().vault_chrome_dropdowns_hidden, 1);
    menu.closeVaultMenu(tabId);
    await settle();
    assert.deepEqual(dropdownClaims(tabId).at(-1), "history", "closing the menu leaves the field's own form-history claim");
  } finally {
    stop();
    menu.closeVaultMenu(tabId);
  }
});

test("on an Ardia profile Chrome's login dropdown closes even when it offers a login Ardia's menu lacks, and Ardia's index refreshes", async () => {
  const { tabId } = await setup("locked");
  const stop = startMenusAndDropdowns();
  try {
    native.vaultFakes.dropdownClaims.length = 0;
    native.vaultFakes.dropdownShowing = ["login"];
    native.vaultFakes.dropdownLogins = ["luke"];
    menu.noteVaultField(tabId, field({ kind: "username" }));
    await settle();
    await settle();
    assert.equal(native.vaultFakes.dropdownClaims.find((c) => c.kinds.includes("login"))?.anyLogin, true, "the menu claims every login Chrome could offer");
    assert.deepEqual(native.vaultFakes.dropdownShowing, [], "Chrome's dropdown closes");
    assert.ok(menu.vaultMenuOf(tabId), "Ardia's menu stays");
    takeVaultCounts();
    dropdowns.noteAutofillSuggestions(tabId, 2, ["login"], false, ["luke"]);
    assert.ok(menu.vaultMenuOf(tabId), "a login only Chrome lists doesn't make the menu give way");
    assert.equal(takeVaultCounts().vault_menu_yields_to_chrome, 0);
  } finally {
    native.vaultFakes.dropdownShowing = [];
    native.vaultFakes.dropdownLogins = [];
    stop();
    menu.closeVaultMenu(tabId);
  }
});

test("a login saved for a sibling host shows in Ardia's menu with its host, so Chrome's matching dropdown closes", async () => {
  const { tabId } = await setup();
  native.vaultFakes.items = [{ provider: "bitwarden", id: "home", title: "home.leech.party", username: "luke", urls: ["https://home.leech.party"], hasTotp: false }];
  await store.loadAllVaultItems(true);
  const stop = startMenusAndDropdowns();
  try {
    native.vaultFakes.dropdownClaims.length = 0;
    native.vaultFakes.dropdownShowing = ["login"];
    native.vaultFakes.dropdownLogins = ["luke"];
    menu.noteVaultField(tabId, field({ kind: "username", origin: "https://server.leech.party" }));
    await settle();
    await settle();
    const open = menu.vaultMenuOf(tabId);
    const sibling = open && menu.rowsOfMenu(open).find((r) => r.kind === "login");
    assert.equal(sibling?.item.urls[0], "https://home.leech.party");
    assert.equal(sibling?.userChose, true, "a sibling fills only when picked");
    assert.deepEqual(native.vaultFakes.dropdownShowing, [], "Chrome's dropdown closed");
    assert.ok(menu.vaultMenuOf(tabId));
    dropdowns.noteAutofillSuggestions(tabId, 2, ["login"], false, ["luke", "other-user"]);
    assert.ok(menu.vaultMenuOf(tabId), "Ardia's menu stays the only one");
  } finally {
    native.vaultFakes.dropdownShowing = [];
    native.vaultFakes.dropdownLogins = [];
    stop();
    menu.closeVaultMenu(tabId);
  }
});

test("Chrome's passkey-only dropdown on a username webauthn field closes, and Ardia's menu opens on focus and stays", async () => {
  const { tabId } = await setup();
  native.vaultFakes.items = [];
  await store.loadAllVaultItems(true);
  const stop = startMenusAndDropdowns();
  try {
    native.vaultFakes.dropdownClaims.length = 0;
    native.vaultFakes.dropdownShowing = ["history", "passkey"];
    menu.noteVaultField(tabId, field({ kind: "username", origin: "https://accounts.example.com", webauthn: true, formHasPassword: false }));
    await settle();
    await settle();
    assert.ok(menu.vaultMenuOf(tabId), "a webauthn field opens Ardia's menu on focus even with nothing saved for it");
    assert.deepEqual(native.vaultFakes.dropdownShowing, [], "neither the typed-before email nor Use Passkey from Another Device stays up");
    takeVaultCounts();
    dropdowns.noteAutofillSuggestions(tabId, 2, ["history", "passkey"], false);
    assert.ok(menu.vaultMenuOf(tabId), "the passkey dropdown doesn't make the menu give way");
    assert.equal(takeVaultCounts().vault_menu_yields_to_chrome, 0);
    menu.closeVaultMenu(tabId);
    menu.noteVaultField(tabId, field({ kind: "username", origin: "https://accounts.example.com", frameId: "f9", webauthn: false, formHasPassword: false }));
    await settle();
    assert.equal(menu.vaultMenuOf(tabId), null, "a plain field with nothing to offer still waits to be asked");
  } finally {
    native.vaultFakes.dropdownShowing = [];
    stop();
    menu.closeVaultMenu(tabId);
  }
});

test("a passkey or other suggestion Ardia can't offer makes the menu give way, even with logins to fill", async () => {
  const { tabId } = await setup();
  const stop = startMenusAndDropdowns();
  try {
    menu.noteVaultField(tabId, field());
    await settle();
    takeVaultCounts();
    dropdowns.noteAutofillSuggestions(tabId, 2, ["login", "other"], false);
    assert.equal(menu.vaultMenuOf(tabId), null);
    assert.equal(takeVaultCounts().vault_menu_yields_to_chrome, 1);
  } finally {
    stop();
    menu.closeVaultMenu(tabId);
  }
});

test("Chrome's address dropdown takes over a menu with only unlock rows, which stays away until asked for", async () => {
  const { tabId } = await setup("locked");
  const stop = startMenusAndDropdowns();
  try {
    menu.noteVaultField(tabId, field());
    await settle();
    dropdowns.noteAutofillSuggestions(tabId, 0);
    assert.ok(menu.vaultMenuOf(tabId), "an empty dropdown changes nothing");
    dropdowns.noteAutofillSuggestions(tabId, 2, ["address"], false);
    assert.equal(menu.vaultMenuOf(tabId), null);
    assert.deepEqual(calls.at(-1), ["menu", false, false]);
    menu.offerToFocusedField(tabId);
    await settle();
    assert.equal(menu.vaultMenuOf(tabId), null, "an automatic offer doesn't fight Chrome's dropdown");
    assert.equal(menu.openVaultMenuOnDemand(tabId), true);
    dropdowns.noteAutofillSuggestions(tabId, 2, ["address"], false);
    assert.equal(menu.vaultMenuOf(tabId)?.onDemand, true, "a menu asked for stays, and Chrome's dropdown closes");
  } finally {
    stop();
    menu.closeVaultMenu(tabId);
  }
});

test("a blur closes the menu after a short grace unless the pointer is on it", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field());
  await settle();
  menu.hoverVaultMenu(tabId, true);
  menu.noteVaultField(tabId, field({ focused: false }));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(menu.vaultMenuOf(tabId), "kept while hovered");
  menu.hoverVaultMenu(tabId, false);
  assert.equal(menu.vaultMenuOf(tabId), null, "leaving after the blur closes it");
});

test("a locked manager offers its unlock row and keeps its items out of memory", async () => {
  const { tabId } = await setup("locked");
  assert.deepEqual(held(), []);
  menu.noteVaultField(tabId, field());
  await settle();
  const rows = menu.rowsOfMenu(menu.vaultMenuOf(tabId));
  assert.deepEqual(rows.map((r) => r.kind), ["unlock", "allPasswords"]);
  assert.equal(menu.vaultMenuOf(tabId).selected, 0, "with nothing to fill, the unlock row is the one Touch ID acts on");
});

test("locking drops the index and pending codes", async () => {
  await setup();
  assert.equal(held().length, 1);
  store.applyProviderState(provider("locked"));
  assert.deepEqual(held(), []);
  assert.deepEqual(store.currentPendingTotp(), []);
});

test("a provider list that lands after a lock never brings the manager back as unlocked", async () => {
  await setup();
  let release;
  native.vaultFakes.providersGate = new Promise((r) => (release = r));
  try {
    const loading = store.loadVaultProviders();
    store.applyProviderState(provider("locked"));
    release();
    await loading;
    await settle();
    assert.equal(store.vaultProviderOf("bitwarden")?.state, "locked");
    assert.deepEqual(held(), []);
  } finally {
    native.vaultFakes.providersGate = null;
  }
});

test("a provider list that says a manager is now locked drops its items", async () => {
  await setup();
  assert.equal(held().length, 1);
  native.vaultFakes.providers = [provider("locked")];
  await store.loadVaultProviders();
  assert.equal(store.vaultProviderOf("bitwarden")?.state, "locked");
  assert.deepEqual(held(), []);
});

test("a new login gets the save offer and Chrome's prompt for it stays hidden", async () => {
  const { tabId } = await setup();
  await offers.noteVaultSubmitted(tabId, { frameId: "f1", origin: "https://github.com", username: "someone-new" });
  assert.equal(offers.useVaultSaveOffers.getState()[tabId]?.target, "bitwarden");
  showPasswordPrompt(tabId, { state: "save", origin: "https://github.com", username: "someone-new", passwordLength: 8, federation: "", usernames: [] });
  assert.equal(pageOf(tabId).passwordPrompt, null);
  await offers.saveVaultOffer(tabId);
  assert.deepEqual(calls.find((c) => c[0] === "save")[1], { provider: "bitwarden", origin: "https://github.com", title: "github.com" });
  assert.equal(offers.useVaultSaveOffers.getState()[tabId], null);
});

test("a login already in the manager gets no offer, its capture is discarded, and Chrome's save prompt stays hidden", async () => {
  const { tabId } = await setup();
  await offers.noteVaultSubmitted(tabId, { frameId: "f1", origin: "https://github.com", username: "OCTO" });
  assert.equal(offers.useVaultSaveOffers.getState()[tabId] ?? null, null);
  assert.deepEqual(calls.at(-1), ["discard", "https://github.com"]);
  showPasswordPrompt(tabId, { state: "save", origin: "https://github.com", username: "OCTO", passwordLength: 8, federation: "", usernames: [] });
  assert.equal(pageOf(tabId).passwordPrompt, null);
  showPasswordPrompt(tabId, { state: "update", origin: "https://github.com", username: "OCTO", passwordLength: 8, federation: "", usernames: [] });
  assert.equal(pageOf(tabId).passwordPrompt?.state, "update", "an update prompt still shows");
});

test("a changed password for a saved login offers Update in a manager that can edit, and Chrome's update prompt stays hidden", async () => {
  const { tabId } = await setup();
  native.vaultFakes.providers = [{ ...provider("unlocked"), capabilities: { ...caps, edit: true } }];
  await store.loadVaultProviders();
  takeVaultCounts();
  await offers.noteVaultSubmitted(tabId, { frameId: "f1", origin: "https://github.com", username: "OCTO", usernameFrom: "form", newPassword: true, trusted: true });
  assert.deepEqual(offers.useVaultSaveOffers.getState()[tabId]?.update, { provider: "bitwarden", id: "gh" });
  showPasswordPrompt(tabId, { state: "update", origin: "https://github.com", username: "OCTO", passwordLength: 8, federation: "", usernames: [] });
  assert.equal(pageOf(tabId).passwordPrompt, null);
  handle.updateAnswer = { edited: false, error: "declined" };
  await offers.saveVaultOffer(tabId);
  assert.equal(offers.useVaultSaveOffers.getState()[tabId]?.error, null, "a declined owner check shows no error");
  handle.updateAnswer = { edited: false, error: "failed" };
  await offers.saveVaultOffer(tabId);
  assert.match(offers.useVaultSaveOffers.getState()[tabId]?.error ?? "", /Couldn't update the password in Bitwarden/);
  handle.updateAnswer = undefined;
  await offers.saveVaultOffer(tabId);
  assert.deepEqual(calls.filter((c) => c[0] === "update").at(-1)[1], { provider: "bitwarden", id: "gh", origin: "https://github.com" });
  assert.equal(calls.some((c) => c[0] === "save"), false, "nothing new is saved");
  assert.equal(offers.useVaultSaveOffers.getState()[tabId], null);
  const counts = takeVaultCounts();
  assert.equal(counts.vault_passwords_updated_from_offer, 1);
  assert.equal(counts.vault_logins_edited_manager, 1);
});

test("a change-password page without a username field updates the site's only login", async () => {
  const { tabId } = await setup();
  native.vaultFakes.providers = [{ ...provider("unlocked"), capabilities: { ...caps, edit: true } }];
  await store.loadVaultProviders();
  await offers.noteVaultSubmitted(tabId, { frameId: "f1", origin: "https://github.com", username: "", newPassword: true, trusted: true });
  assert.equal(offers.useVaultSaveOffers.getState()[tabId]?.update?.id, "gh");
  assert.equal(offers.useVaultSaveOffers.getState()[tabId]?.username, "octo");
});

test("a changed password in a manager that can't edit offers nothing and leaves Chrome's update prompt", async () => {
  const { tabId } = await setup();
  await offers.noteVaultSubmitted(tabId, { frameId: "f1", origin: "https://github.com", username: "octo", usernameFrom: "form", newPassword: true, trusted: true });
  assert.equal(offers.useVaultSaveOffers.getState()[tabId] ?? null, null);
  showPasswordPrompt(tabId, { state: "update", origin: "https://github.com", username: "octo", passwordLength: 8, federation: "", usernames: [] });
  assert.equal(pageOf(tabId).passwordPrompt?.state, "update");
});

test("Not Now discards the captured login", async () => {
  const { tabId } = await setup();
  await offers.noteVaultSubmitted(tabId, { frameId: "f1", origin: "https://github.com", username: "new" });
  offers.dismissVaultOffer(tabId);
  assert.deepEqual(calls.at(-1), ["discard", "https://github.com"]);
});

test("command bar actions show only with a connected manager, copies only with a match", async () => {
  const { w } = await setup();
  assert.deepEqual(vaultBarActions(S(), w).map((a) => a.id), ["vault:fill", "vault:copyPassword", "vault:copyUsername", "vault:lock"]);
  native.vaultFakes.providers = [provider("signedOut")];
  await store.loadVaultProviders();
  store.applyProviderState(provider("signedOut"));
  assert.deepEqual(vaultBarActions(S(), w), []);
});

test("a click on the focused field always brings the menu back, even after Escape and with Suggest on Focus off", async () => {
  const { tabId } = await setup();
  await openMenuNow(tabId);
  noteVaultKey(tabId, { frameId: "f1", key: "Escape" });
  menu.noteVaultField(tabId, field());
  await settle();
  assert.equal(menu.vaultMenuOf(tabId), null, "a plain focus report changes nothing");
  menu.noteVaultField(tabId, field({ clicked: true }));
  assert.ok(menu.vaultMenuOf(tabId), "the click reopens it at once");
  assert.deepEqual(calls.at(-1), ["menu", true, true]);
  menu.closeVaultMenu(tabId);
  S().updateSettings({ vaultSuggestOnFocus: false });
  menu.noteVaultField(tabId, field({ focused: false, rect: null }));
  await openMenuNow(tabId);
  assert.equal(menu.vaultMenuOf(tabId), null, "nothing on focus with suggestions off");
  menu.noteVaultField(tabId, field({ clicked: true }));
  assert.equal(menu.vaultMenuOf(tabId)?.onDemand, true, "a click still asks for it");
});

test("a click on a field with no saved login still opens the menu, and asking needs a focused field with a position", async () => {
  const { tabId } = await setup();
  menu.noteVaultField(tabId, field({ focused: false, rect: null }));
  assert.equal(menu.openVaultMenuOnDemand(tabId), false);
  assert.equal(menu.vaultMenuOf(tabId), null);
  await openMenuNow(tabId, { origin: "https://example.com" });
  assert.equal(menu.vaultMenuOf(tabId), null);
  menu.noteVaultField(tabId, field({ origin: "https://example.com", clicked: true }));
  assert.deepEqual(menu.rowsOfMenu(menu.vaultMenuOf(tabId)).map((r) => r.kind), ["suggest", "allPasswords", "settings"]);
});

test("ArrowDown with the menu closed opens it and lifts Escape's quiet", async () => {
  const { tabId } = await setup();
  await openMenuNow(tabId);
  noteVaultKey(tabId, { frameId: "f1", key: "Escape" });
  noteVaultKey(tabId, { frameId: "other", key: "ArrowDown" });
  assert.equal(menu.vaultMenuOf(tabId), null, "another frame's arrow opens nothing");
  noteVaultKey(tabId, { frameId: "f1", key: "ArrowDown" });
  assert.equal(menu.vaultMenuOf(tabId)?.selected, 0, "opens resting on the login, not one row further");
  menu.closeVaultMenu(tabId);
  menu.noteVaultField(tabId, field({ focused: false, rect: null }));
  await openMenuNow(tabId);
  assert.ok(menu.vaultMenuOf(tabId), "the quiet is gone, so the next focus offers again");
});

test("typing closes the menu until the field is left, unlike Escape, which waits for a click", async () => {
  const { tabId } = await setup();
  const stop = menu.startVaultMenus();
  try {
    await openMenuNow(tabId);
    noteVaultKey(tabId, { frameId: "f1", key: "Typed" });
    assert.equal(menu.vaultMenuOf(tabId), null);
    assert.deepEqual(calls.at(-1), ["menu", false, false]);
    await openMenuNow(tabId);
    assert.equal(menu.vaultMenuOf(tabId), null, "the field's own focus reports don't bring it back");
    menu.offerToFocusedField(tabId);
    await settle();
    assert.equal(menu.vaultMenuOf(tabId), null, "nor does a manager unlocking while the person types");
    menu.noteVaultField(tabId, field({ focused: false, rect: null }));
    await openMenuNow(tabId);
    assert.ok(menu.vaultMenuOf(tabId), "coming back to the field offers it again");
  } finally {
    stop();
  }
});

test("emptying the field offers the menu again, even after Escape", async () => {
  const { tabId } = await setup();
  await openMenuNow(tabId);
  noteVaultKey(tabId, { frameId: "f1", key: "Escape" });
  noteVaultKey(tabId, { frameId: "f1", key: "Cleared" });
  await settle();
  assert.ok(menu.vaultMenuOf(tabId));
  assert.equal(menu.vaultMenuOf(tabId).onDemand, false);
});

test("a field scrolled out of view hides the menu, hands keys back to the page, and shows it again on return", async () => {
  const { tabId } = await setup();
  const opened = await openMenuNow(tabId);
  menu.setVaultMenuOffscreen(tabId, opened.seq, true);
  assert.equal(menu.vaultMenuOf(tabId)?.hidden, true, "still open for the same field");
  assert.deepEqual(calls.at(-1), ["menu", false, false]);
  noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
  await settle();
  assert.deepEqual(fills(), [], "Enter never fills from a menu nobody can see");
  menu.noteVaultField(tabId, field({ rect: { x: 10, y: 300, width: 240, height: 28 } }));
  menu.setVaultMenuOffscreen(tabId, opened.seq, false);
  assert.equal(menu.vaultMenuOf(tabId)?.hidden, false);
  assert.deepEqual(calls.at(-1), ["menu", true, true]);
  assert.equal(menu.vaultMenuOf(tabId).rect.y, 300);
});

test("logins that arrive after the field was focused open the menu", async () => {
  const { tabId } = await setup();
  const stop = menu.startVaultMenus();
  try {
    native.vaultFakes.items = null;
    store.clearVaultIndex();
    await openMenuNow(tabId);
    assert.equal(menu.vaultMenuOf(tabId), null, "the list failed to load");
    native.vaultFakes.items = [login];
    await store.loadVaultItems("bitwarden", true);
    await settle();
    assert.ok(menu.vaultMenuOf(tabId), "the late list opens it");
  } finally {
    native.vaultFakes.items = [login];
    stop();
  }
});

test("a menu message the page missed is sent again, and a page that still routes keys to a closed menu is told it's closed", async () => {
  const { tabId } = await setup();
  let failures = 1;
  await withHandle(
    { setVaultMenu: async (r) => (calls.push(["menu", r.open, r.highlighted]), failures-- > 0 ? Promise.reject(new Error("gone")) : undefined) },
    async () => {
      await openMenuNow(tabId);
      await settle();
      assert.deepEqual(calls.filter((c) => c[0] === "menu"), [["menu", true, true], ["menu", true, true]]);
    },
  );
  menu.closeVaultMenu(tabId);
  calls.length = 0;
  noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
  assert.deepEqual(calls, [["menu", false, false]]);
});

test("the login used last on a site comes first and is the one selected next time", async () => {
  const { tabId } = await setup();
  native.vaultFakes.items = [login, second];
  await store.loadAllVaultItems(true);
  const first = await openMenuNow(tabId);
  const rows = menu.rowsOfMenu(first);
  const workAt = rows.findIndex((r) => r.key === "login:bitwarden/work");
  menu.selectVaultRow(tabId, workAt);
  noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
  await settle();
  assert.equal(fills().at(-1).id, "work");
  menu.noteVaultField(tabId, field({ focused: false, rect: null }));
  menu.noteVaultField(tabId, field({ origin: "https://www.github.com", frameId: "f2", clicked: true }));
  const again = menu.vaultMenuOf(tabId);
  assert.equal(menu.rowsOfMenu(again)[0].key, "login:bitwarden/work");
  assert.equal(again.selected, 0);
  accounts.reloadVaultAccounts();
  assert.equal(accounts.rememberedVaultAccount("https://accounts.github.com"), "bitwarden/work", "kept on disk, for the whole site");
});

test("a remembered login that's gone falls back to the first match", async () => {
  const { tabId } = await setup();
  accounts.rememberVaultAccount("https://github.com", { provider: "bitwarden", id: "deleted" }, null);
  const opened = await openMenuNow(tabId);
  assert.equal(opened.selected, 0);
  assert.equal(menu.rowsOfMenu(opened)[0].key, "login:bitwarden/gh");
});

test("a Touch ID retry flips back to ready, and lockout takes the fingerprint away for this menu", async () => {
  const { tabId } = await setup();
  const opened = await openMenuNow(tabId);
  touch.noteVaultTouchStatus(tabId, opened.seq, "ready");
  touch.noteVaultTouchStatus(tabId, opened.seq, "retry");
  assert.equal(menu.vaultMenuOf(tabId).touch, "retry");
  assert.equal(menu.vaultMenuOf(tabId).touchRetries, 1);
  touch.noteVaultTouchStatus(tabId, opened.seq, "ready");
  touch.noteVaultTouchStatus(tabId, opened.seq, "retry");
  touch.noteVaultTouchStatus(tabId, opened.seq, "ready");
  assert.equal(menu.vaultMenuOf(tabId).touch, "ready");
  assert.equal(menu.vaultMenuOf(tabId).touchRetries, 2);
  touch.noteVaultTouchStatus(tabId, opened.seq + 99, "lockout");
  assert.equal(menu.vaultMenuOf(tabId).touch, "ready", "a status from an older menu is ignored");
  touch.noteVaultTouchStatus(tabId, opened.seq, "lockout");
  touch.armVaultTouchID(tabId, opened.seq);
  assert.equal(touch.grantVaultTouch(tabId, opened.seq), false);
  assert.deepEqual(fills(), []);
  noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
  await settle();
  assert.equal(fills().at(-1).submit, false, "Return still fills, through the system prompt");
});

test("a Touch ID grant fills the row selected at that moment and submits, even if the pointer moves on", async () => {
  const { tabId } = await setup();
  native.vaultFakes.items = [login, second];
  await store.loadAllVaultItems(true);
  const pending = deferred();
  await withHandle({ fillFromVault: async (r) => (calls.push(["fill", r]), pending.promise) }, async () => {
    const opened = await openMenuNow(tabId);
    menu.hoverVaultMenu(tabId, true);
    menu.selectVaultRow(tabId, 1);
    const armedKey = menu.rowsOfMenu(opened)[1].key;
    touch.armVaultTouchID(tabId, opened.seq);
    touch.noteVaultTouchStatus(tabId, opened.seq, "granted");
    menu.selectVaultRow(tabId, 0);
    touch.noteVaultTouchStatus(tabId, opened.seq, "granted");
    assert.equal(fills().length, 1, "one touch fills once");
    assert.equal(`login:bitwarden/${fills()[0].id}`, armedKey);
    assert.equal(fills()[0].submit, true);
    assert.equal(menu.vaultMenuOf(tabId).touch, "granted");
    pending.resolve({ filled: ["username", "password"] });
    await settle();
  });
  assert.equal(menu.vaultMenuOf(tabId), null);
});

test("an expired Touch ID grant says so and arms again", async () => {
  const { tabId } = await setup();
  const opened = await openMenuNow(tabId);
  await withHandle({ fillFromVault: async (r) => (calls.push(["fill", r]), { filled: [], error: "notAuthorized" }) }, async () => {
    touch.armVaultTouchID(tabId, opened.seq);
    touch.noteVaultTouchStatus(tabId, opened.seq, "granted");
    await settle();
  });
  const now = menu.vaultMenuOf(tabId);
  assert.equal(now.error, fillModule.TOUCH_ID_EXPIRED);
  assert.equal(now.busy, null);
  assert.ok(touch.touchIDGlyphShown(now.touch));
  assert.equal(touch.grantVaultTouch(tabId, opened.seq), true, "the next touch can fill");
  await settle();
  assert.equal(menu.vaultMenuOf(tabId), null);
});

test("new password fields offer four generators and pass the field's length limit", async () => {
  const { tabId } = await setup();
  let request = null;
  await withHandle({ fillGeneratedPassword: async (r) => ((request = r), { filled: ["newPassword"] }) }, async () => {
    const opened = await openMenuNow(tabId, { kind: "newPassword", maxLength: 16 });
    const rows = menu.rowsOfMenu(opened);
    assert.deepEqual(rows.map((r) => r.key), ["generate:strong", "generate:alphanumeric", "generate:easyToType", "generate:passphrase", "openPasswords"]);
    assert.equal(opened.selected, 0);
    fillModule.activateVaultRow(tabId, rows[3]);
    await settle();
  });
  assert.deepEqual({ ...request }, { frameId: "f1", origin: "https://github.com", style: "passphrase", maxLength: 16 });
  assert.equal(menu.vaultMenuOf(tabId), null);
});

test("Suggest New Password opens into the four styles with the first selected, Escape folds it back, and Return picks", async () => {
  const { tabId } = await setup();
  let request = null;
  await withHandle({ fillGeneratedPassword: async (r) => ((request = r), { filled: ["newPassword"] }) }, async () => {
    const opened = await openMenuNow(tabId, { maxLength: 0 });
    const suggestAt = menu.rowsOfMenu(opened).findIndex((r) => r.kind === "suggest");
    menu.selectVaultRow(tabId, suggestAt);
    noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
    await settle();
    assert.equal(request, null, "nothing is filled until a style is picked");
    const open = menu.vaultMenuOf(tabId);
    const rows = menu.rowsOfMenu(open);
    assert.deepEqual(rows.filter((r) => r.kind === "generate").map((r) => r.style), ["strong", "alphanumeric", "easyToType", "passphrase"]);
    assert.equal(rows[open.selected].style, "strong");
    assert.deepEqual(calls.at(-1), ["menu", true, true], "the page keeps routing keys to the menu");
    noteVaultKey(tabId, { frameId: "f1", key: "Escape" });
    const folded = menu.vaultMenuOf(tabId);
    assert.ok(folded, "Escape folds the styles, the menu stays");
    assert.equal(menu.rowsOfMenu(folded)[folded.selected].kind, "suggest");
    fillModule.activateVaultRow(tabId, menu.rowsOfMenu(folded)[folded.selected]);
    const again = menu.vaultMenuOf(tabId);
    noteVaultKey(tabId, { frameId: "f1", key: "ArrowDown" });
    noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
    await settle();
    assert.equal(menu.rowsOfMenu(again)[again.selected].style, "strong");
  });
  assert.deepEqual({ ...request }, { frameId: "f1", origin: "https://github.com", style: "alphanumeric" });
});

test("filling a login never copies its one-time code", async (t) => {
  const { w, tabId } = await setup();
  await openMenuNow(tabId);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
  await flush();
  for (let elapsed = 0; elapsed < 5_000; elapsed += 100) {
    t.mock.timers.tick(100);
    await flush();
  }
  assert.deepEqual(native.vaultFakes.copied, []);
  assert.ok(!vaultBarActions(S(), w).some((a) => /code/i.test(a.id) || /code/i.test(a.title)));
});

test("a sign-in the page rejects gets no save offer and its capture is discarded", async () => {
  const { tabId } = await setup();
  const pending = offers.noteVaultSubmitted(tabId, submitted({ username: "someone-new", reportsOutcome: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(offerOf(tabId), null, "nothing is offered before the page says how the sign-in went");
  offers.noteVaultLoginOutcome(tabId, { origin: "https://github.com", ok: false });
  await pending;
  assert.equal(offerOf(tabId), null);
  assert.deepEqual(calls.at(-1), ["discard", "https://github.com"]);
});

test("a sign-in that succeeds, or leaves for a page without the login form, gets the save offer", async () => {
  const { tabId } = await setup();
  const ok = offers.noteVaultSubmitted(tabId, submitted({ username: "someone-new", reportsOutcome: true }));
  await new Promise((r) => setTimeout(r, 0));
  offers.noteVaultLoginOutcome(tabId, { origin: "https://github.com", ok: true });
  await ok;
  assert.equal(offerOf(tabId)?.captured, "someone-new");
  offers.dismissVaultOffer(tabId);
  const left = offers.noteVaultSubmitted(tabId, submitted({ username: "another-new", reportsOutcome: true }));
  await new Promise((r) => setTimeout(r, 0));
  offers.forgetVaultPageSaves(tabId);
  offers.noteVaultLoginOutcome(tabId, { origin: "https://github.com", ok: true });
  await left;
  assert.equal(offerOf(tabId)?.captured, "another-new");
});

test("a new password with a known username saves at once", async () => {
  const { tabId } = await setup();
  await offers.noteVaultSubmitted(tabId, submitted({ username: "new@example.com", newPassword: true }));
  assert.deepEqual(saves(), [{ provider: "bitwarden", origin: "https://github.com", title: "github.com" }]);
  assert.equal(offerOf(tabId), null);
});

test("a remembered login's username never saves by itself; it's the suggestion in the offer", async () => {
  const { tabId } = await setup();
  accounts.rememberVaultAccount("https://login.example.com", login, null);
  native.vaultFakes.items = [{ ...login, urls: ["https://login.example.com"] }];
  await store.loadAllVaultItems(true);
  await offers.noteVaultSubmitted(tabId, submitted({ origin: "https://signup.example.com", generated: true }));
  assert.deepEqual(saves(), []);
  assert.equal(offerOf(tabId)?.username, "octo");
  assert.equal(offerOf(tabId)?.needsUsername, false);
  await offers.saveVaultOffer(tabId);
  assert.equal(saves()[0].username, "octo", "the guess is sent as the username");
  accounts.rememberVaultAccount("https://github.com", login, null);
  await offers.noteVaultSubmitted(tabId, submitted({ newPassword: true }));
  assert.equal(saves().length, 1, "a password change named only by the fallback asks too");
  assert.equal(offerOf(tabId)?.username, "octo");
});

test("a generated password with no username anywhere asks for one, and saves with what's typed", async () => {
  const { tabId } = await setup();
  await offers.noteVaultSubmitted(tabId, submitted({ origin: "https://example.com", generated: true }));
  assert.deepEqual(saves(), []);
  const offer = offerOf(tabId);
  assert.equal(offer.needsUsername, true);
  assert.equal(offer.editing, true);
  assert.equal(offers.canSaveVaultOffer(offer), false);
  offers.setVaultOfferUsername(tabId, "   ");
  await offers.saveVaultOffer(tabId);
  assert.deepEqual(saves(), [], "blank doesn't save");
  offers.setVaultOfferUsername(tabId, " me@example.com ");
  await offers.saveVaultOffer(tabId);
  assert.equal(saves()[0].username, "me@example.com");
  assert.equal(offerOf(tabId), null);
});

test("the same submission twice in a row is handled once", async () => {
  const { tabId } = await setup();
  const event = submitted({ username: "twice@example.com", newPassword: true });
  await Promise.all([offers.noteVaultSubmitted(tabId, event), offers.noteVaultSubmitted(tabId, event)]);
  assert.equal(saves().length, 1);
});

test("a new password for a login already saved, like a Touch ID fill that submitted, is left alone", async () => {
  const { tabId } = await setup();
  await offers.noteVaultSubmitted(tabId, submitted({ username: "octo", newPassword: true }));
  await offers.noteVaultSubmitted(tabId, submitted({ username: "OCTO" }));
  assert.deepEqual(saves(), []);
  assert.equal(offerOf(tabId), null);
});

test("an automatic save that fails shows the offer with the error", async () => {
  const { tabId } = await setup();
  await withHandle({ saveToVault: async (r) => (calls.push(["save", r]), { saved: false }) }, async () => {
    await offers.noteVaultSubmitted(tabId, submitted({ username: "new@example.com", newPassword: true }));
  });
  assert.equal(saves().length, 1);
  assert.equal(offerOf(tabId)?.error, "Couldn't save to Bitwarden. Try again.");
  assert.equal(offerOf(tabId)?.username, "new@example.com");
});

test("with automatic saving off, or several managers and no default, a new password gets the offer", async () => {
  const { tabId } = await setup();
  S().updateSettings({ vaultAutoSave: false });
  await offers.noteVaultSubmitted(tabId, submitted({ username: "a@example.com", newPassword: true }));
  assert.deepEqual(saves(), []);
  assert.equal(offerOf(tabId)?.username, "a@example.com");
  offers.dismissVaultOffer(tabId);
  S().updateSettings({ vaultAutoSave: true });
  native.vaultFakes.providers = [provider("unlocked"), { ...provider("unlocked"), id: "protonpass", name: "Proton Pass" }];
  await store.loadVaultProviders();
  await offers.noteVaultSubmitted(tabId, submitted({ username: "b@example.com", generated: true }));
  assert.deepEqual(saves(), []);
  assert.deepEqual(offerOf(tabId)?.targets, ["bitwarden", "protonpass"]);
});

test("the username in an ordinary offer can be changed before saving", async () => {
  const { tabId } = await setup();
  await offers.noteVaultSubmitted(tabId, submitted({ username: "typo@example.con" }));
  assert.equal(offerOf(tabId).editing, false);
  offers.editVaultOfferUsername(tabId);
  offers.setVaultOfferUsername(tabId, "typo@example.com");
  await offers.saveVaultOffer(tabId);
  assert.equal(saves()[0].username, "typo@example.com");
});

test("a saved login becomes the remembered one for its site", async () => {
  const { tabId } = await setup();
  await withHandle({ saveToVault: async (r) => (calls.push(["save", r]), { saved: true, item: { ...second, id: "fresh" } }) }, async () => {
    await offers.noteVaultSubmitted(tabId, submitted({ username: "fresh@example.com", newPassword: true }));
  });
  assert.equal(accounts.rememberedVaultAccount("https://github.com"), "bitwarden/fresh");
});

test("the login just filled in this tab is only a suggestion for a new password", async () => {
  const { tabId } = await setup();
  native.vaultFakes.items = [{ ...login, urls: ["https://login.example.com"] }];
  await store.loadAllVaultItems(true);
  menu.noteVaultField(tabId, field({ origin: "https://login.example.com", clicked: true }));
  await settle();
  noteVaultKey(tabId, { frameId: "f1", key: "Enter" });
  await settle();
  native.docs.delete(accounts.VAULT_ACCOUNTS_DOC);
  accounts.reloadVaultAccounts();
  await offers.noteVaultSubmitted(tabId, submitted({ origin: "https://app.example.com", newPassword: true }));
  assert.deepEqual(saves(), []);
  assert.equal(offerOf(tabId)?.username, "octo");
});

test("only a trusted submit with the form's own username saves by itself", async () => {
  const { tabId } = await setup();
  await offers.noteVaultSubmitted(tabId, submitted({ username: "guess@example.com", usernameFrom: "nearby", newPassword: true }));
  assert.deepEqual(saves(), []);
  assert.equal(offerOf(tabId)?.username, "guess@example.com");
  offers.dismissVaultOffer(tabId);
  await offers.noteVaultSubmitted(tabId, submitted({ username: "octo", usernameFrom: "page", newPassword: true }));
  assert.equal(offerOf(tabId)?.username, "octo", "a page guess that matches a saved login is not a password change");
  offers.dismissVaultOffer(tabId);
  await offers.noteVaultSubmitted(tabId, submitted({ username: "script@example.com", newPassword: true, trusted: false }));
  assert.deepEqual(saves(), [], "a submit the page made itself asks");
  assert.equal(offerOf(tabId)?.username, "script@example.com");
});

test("one automatic save per page load; the next asks, and a new page saves again", async () => {
  const { tabId } = await setup();
  await offers.noteVaultSubmitted(tabId, submitted({ username: "one@example.com", newPassword: true }));
  await offers.noteVaultSubmitted(tabId, submitted({ username: "two@example.com", newPassword: true }));
  assert.deepEqual(saves().map((s) => s.origin), ["https://github.com"]);
  assert.equal(offerOf(tabId)?.username, "two@example.com");
  offers.dismissVaultOffer(tabId);
  menu.forgetVaultPage(tabId);
  await offers.noteVaultSubmitted(tabId, submitted({ username: "three@example.com", newPassword: true }));
  assert.equal(saves().length, 2);
});

test("a submission that arrives while the same save is running is ignored", async () => {
  const { tabId } = await setup();
  const pending = deferred();
  await withHandle({ saveToVault: async (r) => (calls.push(["save", r]), pending.promise) }, async () => {
    const first = offers.noteVaultSubmitted(tabId, submitted({ username: "slow@example.com", newPassword: true }));
    await settle();
    await settle();
    assert.equal(saves().length, 1);
    await new Promise((r) => setTimeout(r, offers.SAME_SUBMISSION_MS + 50));
    await offers.noteVaultSubmitted(tabId, submitted({ username: "SLOW@example.com", newPassword: true }));
    pending.resolve({ saved: true });
    await first;
  });
  assert.equal(saves().length, 1);
  assert.equal(offerOf(tabId), null);
});

test("a touch acts on whatever row is selected, like a click", async () => {
  const { tabId } = await setup();
  const opened = await openMenuNow(tabId);
  touch.armVaultTouchID(tabId, opened.seq);
  menu.selectVaultRow(tabId, menu.rowsOfMenu(opened).findIndex((r) => r.kind === "allPasswords"));
  touch.noteVaultTouchStatus(tabId, opened.seq, "granted");
  assert.deepEqual(fills(), []);
  assert.equal(menu.vaultMenuOf(tabId).mode, "search", "Other Passwords opens");
});

test("a click that lands on a row right after the menu shows or jumps is ignored, as Chrome ignores early clicks on its own list", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { tabId } = await setup();
  const opened = await openMenuNow(tabId);
  const row = menu.rowsOfMenu(opened).find((r) => r.kind === "login");
  takeVaultCounts();
  fillModule.clickVaultRow(tabId, row);
  await settle();
  assert.deepEqual(fills(), [], "too soon after it showed");
  t.mock.timers.tick(fillModule.EARLY_CLICK_MS);
  menu.patchVaultMenu(tabId, { rect: { ...field().rect, y: 400 } });
  fillModule.clickVaultRow(tabId, row);
  await settle();
  assert.deepEqual(fills(), [], "too soon after the field moved it");
  t.mock.timers.tick(fillModule.EARLY_CLICK_MS);
  menu.patchVaultMenu(tabId, { rect: { ...field().rect, y: 401 } });
  fillModule.clickVaultRow(tabId, row);
  for (let i = 0; i < 3 && !fills().length; i++) await settle();
  assert.equal(fills().length, 1, "a settled menu fills on click, and a one-point nudge doesn't count as a jump");
  assert.equal(takeVaultCounts().vault_menu_early_clicks_ignored, 2);
});

test("one touch on a locked manager unlocks it and fills the login, then submits", async () => {
  const { tabId } = await setup("locked");
  native.vaultFakes.providers = [{ ...provider("locked"), touchUnlock: true }];
  await store.loadVaultProviders();
  const opened = await openMenuNow(tabId);
  assert.equal(menu.rowsOfMenu(opened)[opened.selected].kind, "unlock");
  touch.armVaultTouchID(tabId, opened.seq);
  touch.noteVaultTouchStatus(tabId, opened.seq, "granted");
  for (let i = 0; i < 5 && !fills().length; i++) await settle();
  assert.equal(native.vaultFakes.unlocks.at(-1).withPassword, false);
  assert.deepEqual(native.vaultFakes.unlocks.at(-1).handOn, { tab: tabId, origin: "https://github.com" }, "the unlock hands its touch on to a fill in this tab and site");
  assert.equal(fills().length, 1, "the same touch fills, with no second one");
  assert.equal(fills()[0].id, "gh");
  assert.deepEqual(fills()[0].fields, ["username", "password"]);
  assert.equal(fills()[0].submit, true);
});

test("clicking the unlock row unlocks and fills without submitting", async () => {
  const { tabId } = await setup("locked");
  native.vaultFakes.providers = [{ ...provider("locked"), touchUnlock: true }];
  await store.loadVaultProviders();
  const opened = await openMenuNow(tabId);
  fillModule.activateVaultRow(tabId, menu.rowsOfMenu(opened)[opened.selected]);
  for (let i = 0; i < 5 && !fills().length; i++) await settle();
  assert.equal(fills().length, 1);
  assert.equal(fills()[0].submit, false);
});

test("a touch on the code step fills the code and submits", async () => {
  const { tabId } = await setup();
  store.setPendingTotp([{ origin: "https://github.com", tabId, provider: "bitwarden", id: "gh", at: Date.now() }]);
  const opened = await openMenuNow(tabId, { kind: "otp", formHasPassword: false });
  const row = menu.rowsOfMenu(opened)[opened.selected];
  assert.equal(row.kind, "otp");
  assert.equal(touch.isTouchRow(row), true);
  touch.armVaultTouchID(tabId, opened.seq);
  touch.noteVaultTouchStatus(tabId, opened.seq, "granted");
  await settle();
  assert.deepEqual(fills()[0].fields, ["totp"]);
  assert.equal(fills()[0].submit, true);
});

test("sync unlocks a locked manager first, then reports when it finished", async () => {
  await setup("locked");
  native.vaultFakes.providers = [{ ...provider("locked"), touchUnlock: true }];
  await store.loadVaultProviders();
  const before = native.vaultFakes.syncs;
  const running = sync.syncVaultsNow();
  assert.equal(sync.useVaultSync.getState().phase, "syncing");
  assert.equal(await sync.syncVaultsNow(), null, "a second press while syncing does nothing");
  const result = await running;
  assert.equal(native.vaultFakes.syncs, before + 1);
  assert.deepEqual(result.synced, ["bitwarden"]);
  assert.equal(sync.useVaultSync.getState().phase, "synced");
  assert.equal(sync.syncedLine(result.syncedAt, result.syncedAt + 5 * 60_000), "Synced 5 min ago");
  assert.equal(sync.syncedLine(null, Date.now()), undefined);
});

test("a code filled for a sibling subdomain isn't pending there, so its row still has the origin check", async () => {
  const { tabId } = await setup();
  native.vaultFakes.items = [{ ...login, urls: ["https://accounts.github.com"] }];
  await store.loadAllVaultItems(true);
  store.setPendingTotp([{ origin: "https://accounts.github.com", tabId, provider: "bitwarden", id: "gh", at: Date.now() }]);
  const opened = await openMenuNow(tabId, { kind: "otp", formHasPassword: false, origin: "https://verify.github.com" });
  const rows = opened ? menu.rowsOfMenu(opened).filter((r) => r.kind === "otp") : [];
  assert.equal(rows.some((r) => r.pending), false);
});

test("opening a code menu fetches its codes at once, and a login fill fetches the code it queues", async () => {
  const { tabId } = await setup();
  codes.clearVaultCodes();
  store.setPendingTotp([{ origin: "https://github.com", tabId, provider: "bitwarden", id: "gh", at: Date.now() }]);
  await openMenuNow(tabId, { kind: "otp", formHasPassword: false });
  assert.ok(codes.useVaultCodes.getState()["bitwarden/gh"], "asked before any row renders");
  await settle();
  assert.equal(codes.useVaultCodes.getState()["bitwarden/gh"].code, "123456");
  menu.closeVaultMenu(tabId);
  codes.clearVaultCodes();
  store.setPendingTotp([]);
  await openMenuNow(tabId, { frameId: "f2" });
  noteVaultKey(tabId, { frameId: "f2", key: "Enter" });
  await settle();
  await settle();
  assert.equal(codes.useVaultCodes.getState()["bitwarden/gh"].code, "123456", "ready before the code step shows");
});

test("a code asked for before a lock never lands after it", async () => {
  await setup();
  codes.clearVaultCodes();
  let release;
  native.vaultFakes.totpGate = new Promise((r) => (release = r));
  try {
    const early = codes.loadVaultCode(login);
    codes.clearVaultCodes();
    native.vaultFakes.totpCode = "654321";
    const late = codes.loadVaultCode(login);
    release();
    await early;
    await late;
    assert.equal(codes.useVaultCodes.getState()["bitwarden/gh"].code, "654321");
  } finally {
    native.vaultFakes.totpGate = null;
    native.vaultFakes.totpCode = "123456";
  }
});

test("a fill the page couldn't place keeps the menu open and says so, instead of closing silently", async () => {
  const { tabId } = await setup();
  await withHandle({ fillFromVault: async (r) => (calls.push(["fill", r]), { filled: [] }) }, async () => {
    store.setPendingTotp([{ origin: "https://github.com", tabId, provider: "bitwarden", id: "gh", at: Date.now() }]);
    const opened = await openMenuNow(tabId, { kind: "otp", formHasPassword: false });
    fillModule.activateVaultRow(tabId, menu.rowsOfMenu(opened)[opened.selected]);
    await settle();
  });
  const open = menu.vaultMenuOf(tabId);
  assert.ok(open);
  assert.equal(open.error, fillModule.NOTHING_FILLED);
  assert.equal(open.busy, null);
});

test("a code the manager doesn't have says so on a code field", async () => {
  const { tabId } = await setup();
  await withHandle({ fillFromVault: async () => ({ filled: [], error: "notFound" }) }, async () => {
    store.setPendingTotp([{ origin: "https://github.com", tabId, provider: "bitwarden", id: "gh", at: Date.now() }]);
    const opened = await openMenuNow(tabId, { kind: "otp", formHasPassword: false });
    fillModule.activateVaultRow(tabId, menu.rowsOfMenu(opened)[opened.selected]);
    await settle();
  });
  assert.equal(menu.vaultMenuOf(tabId)?.error, fillModule.NO_CODE);
});

test("deleting a generated password brings the menu back on that field and drops the captured password", async () => {
  const { tabId } = await setup();
  S().updateSettings({ vaultSuggestOnFocus: false });
  const newField = { kind: "newPassword", formHasPassword: true, clicked: true };
  const opened = await openMenuNow(tabId, newField);
  fillModule.activateVaultRow(tabId, menu.rowsOfMenu(opened)[0]);
  await settle();
  assert.equal(menu.vaultMenuOf(tabId), null);
  menu.noteVaultField(tabId, field({ kind: "newPassword", focused: false, rect: null }));
  menu.noteVaultField(tabId, field({ kind: "newPassword" }));
  await settle();
  assert.equal(menu.vaultMenuOf(tabId), null, "a plain focus right after the fill stays quiet");
  calls.length = 0;
  noteVaultKey(tabId, { frameId: "f1", key: "Cleared" });
  await settle();
  assert.equal(menu.vaultMenuOf(tabId)?.field, "newPassword", "back, even with Suggest on Focus off");
  assert.deepEqual(calls.filter((c) => c[0] === "discard"), [["discard", "https://github.com"]]);
  noteVaultKey(tabId, { frameId: "f1", key: "Cleared" });
  assert.equal(calls.filter((c) => c[0] === "discard").length, 1, "dropped once");
  S().updateSettings({ vaultSuggestOnFocus: true });
});

test("a generated password emptied while the menu is open again keeps the menu and drops the capture", async () => {
  const { tabId } = await setup();
  const opened = await openMenuNow(tabId, { kind: "newPassword", clicked: true });
  fillModule.activateVaultRow(tabId, menu.rowsOfMenu(opened)[0]);
  await settle();
  menu.noteVaultField(tabId, field({ kind: "newPassword", clicked: true }));
  const reopened = menu.vaultMenuOf(tabId);
  assert.ok(reopened);
  calls.length = 0;
  noteVaultKey(tabId, { frameId: "f1", key: "Cleared" });
  assert.equal(menu.vaultMenuOf(tabId)?.seq, reopened.seq);
  assert.deepEqual(calls.filter((c) => c[0] === "discard"), [["discard", "https://github.com"]]);
});

test("a username used before fills only that username, as the person's choice and without submitting", async () => {
  const { tabId } = await setup();
  native.vaultFakes.items = [login, { provider: "bitwarden", id: "mail", title: "Mail", username: "octo@mail.test", urls: ["https://mail.test"], updatedAt: 5 }];
  await store.loadAllVaultItems(true);
  const opened = await openMenuNow(tabId, { kind: "username", origin: "https://signup.example", email: true, clicked: true });
  const rows = menu.rowsOfMenu(opened);
  assert.deepEqual(rows.filter((r) => r.kind === "username").map((r) => r.username), ["octo@mail.test", "octo"]);
  assert.equal(opened.selected, 0);
  await withHandle({ fillFromVault: async (r) => (calls.push(["fill", r]), { filled: ["username"] }) }, async () => {
    fillModule.activateVaultRow(tabId, rows[0]);
    await settle();
  });
  assert.deepEqual({ ...fills()[0] }, { frameId: "f1", origin: "https://signup.example", provider: "bitwarden", id: "mail", fields: ["username"], userChose: true, submit: false });
  assert.equal(menu.vaultMenuOf(tabId), null);
});
