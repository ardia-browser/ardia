import assert from "node:assert/strict";
import { test } from "node:test";

const { chooseSaveTarget, connectedSavers, decideSave, decideUpdate, forgetClosedVaultSaves, preferredSaveTarget, saveTargets, useVaultSaveOffers, vaultClaimsPasswordPrompt } = await import("./saveOffer.ts");

const caps = (save) => ({ totp: true, save, selfHosted: false, masterPassword: false, touchID: false });
const provider = (id, state = "unlocked", save = true) => ({ id, name: id, state, capabilities: caps(save), install: { command: "", url: "" } });
const item = (provider, username, urls = ["https://example.com"]) => ({ provider, id: `${provider}-${username}`, title: "Example", username, urls, hasTotp: false });
const input = (over = {}) => ({ enabled: true, origin: "https://example.com", username: "me@example.com", providers: [provider("bitwarden")], items: [], preferred: "", ...over });

test("no offer when the login is already in a connected manager, whatever the case of the username", () => {
  assert.deepEqual(decideSave(input({ items: [item("bitwarden", "Me@Example.COM")] })), { offer: false, alreadySaved: true });
  assert.deepEqual(decideSave(input({ origin: "https://login.example.com", items: [item("bitwarden", "me@example.com")] })), { offer: false, alreadySaved: true });
});

test("no offer when it's turned off, the page isn't secure, or nothing unlocked can save", () => {
  assert.equal(decideSave(input({ enabled: false })).offer, false);
  assert.equal(decideSave(input({ origin: "http://example.com" })).offer, false);
  assert.equal(decideSave(input({ providers: [provider("bitwarden", "locked")] })).offer, false);
  assert.equal(decideSave(input({ providers: [provider("onepassword", "unlocked", false)] })).offer, false);
  assert.equal(decideSave(input({ providers: [] })).offer, false);
});

test("an item in a locked manager doesn't count as saved", () => {
  const decision = decideSave(input({ providers: [provider("bitwarden"), provider("1password", "locked")], items: [item("1password", "me@example.com")] }));
  assert.equal(decision.offer, true);
});

test("a different username or another site gets the offer", () => {
  assert.equal(decideSave(input({ items: [item("bitwarden", "other@example.com")] })).offer, true);
  assert.equal(decideSave(input({ items: [item("bitwarden", "me@example.com", ["https://example.org"])] })).offer, true);
});

test("a chosen manager takes every offer; otherwise the person picks, starting with the first", () => {
  const providers = [provider("1password"), provider("bitwarden"), provider("protonpass", "locked")];
  assert.deepEqual(saveTargets(providers), ["1password", "bitwarden"]);
  assert.deepEqual(decideSave(input({ providers, preferred: "bitwarden" })), { offer: true, targets: ["bitwarden"], target: "bitwarden" });
  assert.deepEqual(decideSave(input({ providers })), { offer: true, targets: ["1password", "bitwarden"], target: "1password" });
  assert.equal(decideSave(input({ providers, preferred: "protonpass" })).target, "1password");
  assert.equal(chooseSaveTarget([], "x"), "");
});

test("the picker lists connected managers that can save, and a lone one is the default", () => {
  const providers = [provider("1password", "locked"), provider("bitwarden", "signedOut"), provider("protonpass", "notInstalled"), provider("enpass", "unlocked", false)];
  assert.deepEqual(connectedSavers(providers).map((p) => p.id), ["1password"]);
  assert.equal(preferredSaveTarget(providers, ""), "1password");
  assert.equal(preferredSaveTarget(providers, "bitwarden"), "1password");
  const two = [provider("1password", "locked"), provider("bitwarden")];
  assert.equal(preferredSaveTarget(two, ""), "");
  assert.equal(preferredSaveTarget(two, "1password"), "1password");
  assert.equal(preferredSaveTarget(two, "protonpass"), "");
  assert.equal(preferredSaveTarget([], ""), "");
});

test("saving uses the lone connected manager without asking, like the picker shows", () => {
  const providers = [provider("bitwarden"), provider("protonpass", "signedOut")];
  assert.deepEqual(decideSave(input({ providers })), { offer: true, targets: ["bitwarden"], target: "bitwarden" });
  assert.deepEqual(decideSave(input({ providers, preferred: "protonpass" })), { offer: true, targets: ["bitwarden"], target: "bitwarden" });
  const lockedChoice = [provider("1password", "locked"), provider("bitwarden")];
  assert.deepEqual(decideSave(input({ providers: lockedChoice, preferred: "1password" })), { offer: true, targets: ["bitwarden"], target: "bitwarden" });
});

test("Chrome's prompt stays for tabs and sites the managers didn't claim", () => {
  assert.equal(vaultClaimsPasswordPrompt("no-such-tab", { origin: "https://example.com", state: "save" }), false);
});

test("closing a tab drops its save offer and keeps the offers of open tabs", () => {
  const offer = (origin) => ({ seq: 1, origin, captured: "me", username: "me", editing: false, needsUsername: false, targets: ["bitwarden"], target: "bitwarden", busy: false, error: null });
  useVaultSaveOffers.setState({ closed: offer("https://a.example"), open: offer("https://b.example"), empty: null }, true);
  forgetClosedVaultSaves({ open: {} });
  assert.deepEqual(Object.keys(useVaultSaveOffers.getState()), ["open"]);
  forgetClosedVaultSaves({ open: {} });
  assert.equal(useVaultSaveOffers.getState().open.origin, "https://b.example");
});

const editor = (id, state = "unlocked", edit = true) => ({ ...provider(id, state), capabilities: { ...caps(true), edit } });
const update = (over = {}) => ({ origin: "https://example.com", username: "me@example.com", providers: [editor("bitwarden")], items: [item("bitwarden", "me@example.com")], remembered: null, ...over });

test("no update without a username, on an insecure page, or when the login isn't saved", () => {
  assert.equal(decideUpdate(update({ username: "  " })), null);
  assert.equal(decideUpdate(update({ origin: "http://example.com" })), null);
  assert.equal(decideUpdate(update({ items: [item("bitwarden", "other@example.com")] })), null);
  assert.equal(decideUpdate(update({ items: [] })), null);
});

test("no update in a manager that can't edit or is locked", () => {
  assert.equal(decideUpdate(update({ providers: [editor("bitwarden", "unlocked", false)] })), null);
  assert.equal(decideUpdate(update({ providers: [provider("protonpass")], items: [item("protonpass", "me@example.com")] })), null);
  assert.equal(decideUpdate(update({ providers: [editor("bitwarden", "locked")] })), null);
});

test("a sibling site's login isn't updated, a subdomain's is", () => {
  assert.equal(decideUpdate(update({ origin: "https://mail.example.com", items: [item("bitwarden", "me@example.com", ["https://accounts.example.com"])] })), null);
  assert.deepEqual(decideUpdate(update({ origin: "https://login.example.com" })), { provider: "bitwarden", id: "bitwarden-me@example.com" });
});

test("the saved login with that username is updated, whatever its case", () => {
  assert.deepEqual(decideUpdate(update({ username: "Me@Example.COM" })), { provider: "bitwarden", id: "bitwarden-me@example.com" });
});

test("Ardia's own logins can always be updated", () => {
  const ardia = { ...provider("ardia"), capabilities: caps(true) };
  assert.deepEqual(decideUpdate(update({ providers: [ardia], items: [item("ardia", "me@example.com")] })), { provider: "ardia", id: "ardia-me@example.com" });
});

test("with the login in two managers, the one used last on the site wins, else the first", () => {
  const providers = [editor("1password"), editor("bitwarden")];
  const items = [item("1password", "me@example.com"), item("bitwarden", "me@example.com")];
  assert.equal(decideUpdate(update({ providers, items })).provider, "1password");
  assert.equal(decideUpdate(update({ providers, items, remembered: "bitwarden/bitwarden-me@example.com" })).provider, "bitwarden");
});

test("an exact host match beats a subdomain match for the same username", () => {
  const items = [item("bitwarden", "me@example.com", ["https://example.com"]), { ...item("bitwarden", "me@example.com", ["https://app.example.com"]), id: "app" }];
  assert.equal(decideUpdate(update({ origin: "https://app.example.com", items })).id, "app");
});

test("a change-password page without a username updates only the site's one account", async () => {
  const { soleSiteUsername } = await import("./saveOffer.ts");
  const at = (username, urls) => item("bitwarden", username, urls);
  assert.equal(soleSiteUsername([at("me@example.com"), { ...at("ME@example.com"), provider: "1password" }], "https://example.com"), "me@example.com");
  assert.equal(soleSiteUsername([at("me@example.com"), at("you@example.com")], "https://example.com"), "");
  assert.equal(soleSiteUsername([at("me@example.com"), at("you@example.com", ["https://other.org"])], "https://example.com"), "me@example.com");
  assert.equal(soleSiteUsername([at("me@example.com", ["https://accounts.example.com"])], "https://mail.example.com"), "");
  assert.equal(soleSiteUsername([at("")], "https://example.com"), "");
  assert.equal(soleSiteUsername([], "https://example.com"), "");
});
