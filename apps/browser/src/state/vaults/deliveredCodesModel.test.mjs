import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveredAge, deliveredFillError, deliveredItem, deliveredLines, liveDelivered, MAX_DELIVERED_ROWS } from "./deliveredCodesModel.ts";
import { hasMatchRow, menuRows, restingRow, soleRestingFill } from "./menuModel.ts";
import { codeItem } from "./standaloneCodesModel.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const provider = (id) => ({ id, name: id, state: "unlocked", capabilities: { totp: true, save: true, selfHosted: false, masterPassword: false, touchID: false }, install: { command: "", url: "" } });
const sent = (id, extra = {}) => ({ id: `delivered.${id}`, source: "messages", sender: "12345", site: null, bound: false, receivedAt: NOW - MIN, expiresAt: NOW + 9 * MIN, ...extra });
const base = { field: "otp", mode: "matches", origin: "https://github.com", query: "", providers: [provider("ardia")], items: [], pending: null, noTotp: new Set() };
const otps = (rows) => rows.filter((r) => r.kind === "otp").map((r) => r.item.id);
const chose = (rows) => Object.fromEntries(rows.filter((r) => r.kind === "otp").map((r) => [r.item.id, r.userChose]));

test("codes on the page's site come first, then the newest, at most three, before saved codes", () => {
  const delivered = [
    sent("old-here", { site: "github.com", receivedAt: NOW - 5 * MIN }),
    sent("newest", { receivedAt: NOW - 10_000 }),
    sent("middle", { source: "mail", site: "example.com", receivedAt: NOW - 2 * MIN }),
    sent("oldest", { receivedAt: NOW - 8 * MIN }),
  ].map(deliveredItem);
  const saved = [codeItem({ id: "code.gh", label: "octo", website: "https://github.com" })];
  const rows = menuRows({ ...base, delivered, codes: saved });
  assert.equal(MAX_DELIVERED_ROWS, 3);
  assert.deepEqual(otps(rows), ["delivered.old-here", "delivered.newest", "delivered.middle", "code.gh"]);
});

test("a code subdomain of the page's site counts as on the site", () => {
  const delivered = [sent("other", { receivedAt: NOW }), sent("here", { site: "github.com", receivedAt: NOW - 3 * MIN })].map(deliveredItem);
  assert.deepEqual(otps(menuRows({ ...base, origin: "https://gist.github.com", delivered })), ["delivered.here", "delivered.other"]);
});

test("only a code bound to the page's site fills without a pick; unbound codes wait for a click; codes bound elsewhere never show", () => {
  const delivered = [
    sent("bound-here", { site: "github.com", bound: true, receivedAt: NOW - 1000 }),
    sent("hint-here", { site: "github.com", receivedAt: NOW - 2000 }),
    sent("bound-elsewhere", { site: "gitlab.com", bound: true, receivedAt: NOW - 3000 }),
  ].map(deliveredItem);
  const rows = menuRows({ ...base, delivered });
  assert.deepEqual(chose(rows), { "delivered.bound-here": false, "delivered.hint-here": true });
  assert.equal(rows[restingRow(rows)].item.id, "delivered.bound-here");
});

test("an unbound code alone is never the resting fill, so Return and Touch ID can't send it unasked", () => {
  const rows = menuRows({ ...base, delivered: [deliveredItem(sent("a", { site: "github.com" }))] });
  assert.equal(soleRestingFill(rows), null);
  assert.equal(rows[restingRow(rows)].item.id, "delivered.a", "it is still the row selected, for a click");
});

test("delivered codes show only on code fields in the matches list, and follow their own setting", () => {
  const delivered = [deliveredItem(sent("a"))];
  for (const field of ["password", "username", "newPassword"]) assert.deepEqual(otps(menuRows({ ...base, field, delivered })), []);
  assert.deepEqual(otps(menuRows({ ...base, mode: "search", query: "12345", delivered })), []);
  const suggest = { logins: true, codes: true, delivered: false, usernames: true, newPasswords: true, generated: true };
  assert.deepEqual(otps(menuRows({ ...base, delivered, suggest })), []);
  assert.deepEqual(otps(menuRows({ ...base, delivered, suggest: { ...suggest, delivered: true, codes: false } })), ["delivered.a"], "each kind follows its own flag here; suggestOf ties them together");
});

test("a code the engine no longer has drops out of the menu", () => {
  const delivered = [deliveredItem(sent("a")), deliveredItem(sent("b", { receivedAt: NOW - 2 * MIN }))];
  assert.deepEqual(otps(menuRows({ ...base, delivered, noTotp: new Set(["delivered/delivered.a"]) })), ["delivered.b"]);
});

test("the engine's list is checked: expired, malformed and off-access codes are dropped, newest first", () => {
  const state = { access: "on", codes: [sent("a", { receivedAt: NOW - 3 * MIN }), sent("b"), sent("gone", { expiresAt: NOW }), { ...sent("x"), id: "code.x" }, { ...sent("y"), source: "sms" }, null] };
  assert.deepEqual(liveDelivered(state, NOW).codes.map((c) => c.id), ["delivered.b", "delivered.a"]);
  assert.deepEqual(liveDelivered({ access: "needsAccess", codes: [sent("a")] }, NOW), { access: "needsAccess", codes: [] });
  assert.deepEqual(liveDelivered({ access: "weird", codes: [sent("a")] }, NOW), { access: "off", codes: [] });
  assert.deepEqual(liveDelivered(undefined, NOW), { access: "off", codes: [] });
});

test("a delivered item carries no code and points at its site", () => {
  const item = deliveredItem(sent("a", { site: "github.com", sender: "GitHub" }));
  assert.deepEqual({ provider: item.provider, title: item.title, username: item.username, urls: item.urls, hasTotp: item.hasTotp }, { provider: "delivered", title: "GitHub", username: "", urls: ["https://github.com"], hasTotp: true });
  assert.deepEqual(deliveredItem(sent("b")).urls, []);
});

test("the detail reads source, site or sender, and age", () => {
  assert.deepEqual(deliveredLines(sent("a", { source: "mail", sender: "noreply@github.com", site: "github.com", receivedAt: NOW - 20_000 }), NOW, "github.com"), { source: "From Mail", from: "github.com", age: "now" });
  assert.deepEqual(deliveredLines(sent("b", { receivedAt: NOW - 2 * MIN - 5000 }), NOW, "github.com"), { source: "From Messages", from: "12345", age: "2 min ago" });
  assert.equal(deliveredAge(NOW + 5000, NOW), "now", "a clock running behind the sender's never shows a negative age");
});

test("fill errors on a delivered code speak about the code", () => {
  assert.match(deliveredFillError("originMismatch"), /another site/);
  assert.equal(deliveredFillError("notFound"), "This code has expired.");
  assert.equal(deliveredFillError("insecure"), null, "the shared insecure-page copy applies");
  assert.doesNotMatch(deliveredFillError("failed"), /login/);
});

test("a code sent for another site says so, and one for this site names it", () => {
  const bank = sent("a", { site: "bank.com", bound: true, receivedAt: NOW });
  assert.equal(deliveredLines(bank, NOW, "evil.example").from, "for bank.com");
  assert.equal(deliveredLines(bank, NOW, "login.bank.com").from, "bank.com");
  assert.equal(deliveredLines(sent("b", { site: "bank.com" }), NOW, "evil.example").from, "for bank.com", "an unbound hint is flagged the same way");
});

test("only a code bound to this site opens the menu by itself; others show only beside a reason to open", () => {
  const offSite = deliveredItem(sent("off", { site: "bank.com", bound: true }));
  const hint = deliveredItem(sent("hint", { site: "github.com" }));
  const noSite = deliveredItem(sent("none"));
  for (const item of [offSite, hint, noSite]) assert.equal(hasMatchRow(menuRows({ ...base, providers: [], delivered: [item] })), false, item.id);
  assert.equal(hasMatchRow(menuRows({ ...base, providers: [], delivered: [deliveredItem(sent("here", { site: "github.com", bound: true }))] })), true);
  const saved = [codeItem({ id: "code.gh", label: "octo", website: "https://github.com" })];
  const rows = menuRows({ ...base, codes: saved, delivered: [offSite, hint] });
  assert.deepEqual(chose(rows), { "delivered.hint": true, "code.gh": false }, "an unbound code shows, waiting for a click; a code bound to another site can never fill here, so it doesn't show");
});
