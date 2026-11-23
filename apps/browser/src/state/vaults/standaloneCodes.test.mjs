import assert from "node:assert/strict";
import { test } from "node:test";
import { codeItem, codeLabels, isCodeItem, matchingCodes, sortedCodes } from "./standaloneCodesModel.ts";
import { menuRows } from "./menuModel.ts";

const provider = (id, state = "unlocked") => ({ id, name: id, state, capabilities: { totp: true, save: true, selfHosted: false, masterPassword: false, touchID: false }, install: { command: "", url: "" } });
const code = (id, label, extra = {}) => ({ id: `code.${id}`, label, ...extra });
const base = { field: "otp", mode: "matches", origin: "https://github.com", query: "", providers: [provider("ardia")], items: [], pending: null, noTotp: new Set() };
const ids = (rows) => rows.filter((r) => r.kind === "otp" || r.kind === "login").map((r) => r.item.id);

test("a code with a website is offered on that site's code fields and its subdomains", () => {
  const codes = [code("a", "octo", { website: "https://github.com" })].map(codeItem);
  assert.deepEqual(ids(menuRows({ ...base, codes })), ["code.a"]);
  assert.deepEqual(ids(menuRows({ ...base, origin: "https://gist.github.com", codes })), ["code.a"]);
  assert.deepEqual(ids(menuRows({ ...base, origin: "https://gitlab.com", codes })), []);
});

test("a sibling site's code is never offered by itself", () => {
  const codes = [code("a", "mail", { website: "https://mail.example.com" })].map(codeItem);
  assert.deepEqual(ids(menuRows({ ...base, origin: "https://accounts.example.com", codes })), []);
});

test("a code with no website is never offered automatically but is found in Other Passwords on a code field", () => {
  const codes = [code("b", "Work VPN")].map(codeItem);
  assert.deepEqual(ids(menuRows({ ...base, codes })), []);
  assert.deepEqual(ids(menuRows({ ...base, mode: "search", query: "vpn", codes })), ["code.b"]);
});

test("codes never show on password or username fields, even in search", () => {
  const codes = [code("a", "octo", { website: "https://github.com" })].map(codeItem);
  for (const field of ["password", "username", "newPassword"]) {
    assert.deepEqual(ids(menuRows({ ...base, field, codes })), []);
    assert.deepEqual(ids(menuRows({ ...base, field, mode: "search", query: "octo", codes })), []);
  }
});

test("codes still fill while Ardia's password switch is off, since they live in Ardia's own file", () => {
  const codes = [code("a", "octo", { website: "https://github.com" })].map(codeItem);
  assert.deepEqual(ids(menuRows({ ...base, providers: [provider("ardia", "unavailable")], codes })), ["code.a"]);
});

test("Verification Codes turned off in Suggest hides them on the site", () => {
  const codes = [code("a", "octo", { website: "https://github.com" })].map(codeItem);
  assert.deepEqual(ids(menuRows({ ...base, codes, suggest: { logins: true, codes: false, usernames: true, newPasswords: true, generated: true } })), []);
});

test("a code item reads as a code, not a login, and carries no username", () => {
  const item = codeItem(code("a", "octo", { issuer: "GitHub", website: "https://github.com", period: 30 }));
  assert.equal(isCodeItem(item), true);
  assert.equal(item.username, "");
  assert.equal(item.title, "octo");
  assert.deepEqual(item.urls, ["https://github.com"]);
  assert.equal(isCodeItem({ provider: "ardia", id: "aHR0cHM6Ly9h" }), false);
});

test("codes sort by label, then issuer, ignoring case and reading numbers as numbers", () => {
  const sorted = sortedCodes([code("1", "b"), code("2", "A", { issuer: "Z" }), code("3", "a", { issuer: "Y" }), code("4", "Item 10"), code("5", "Item 9")]);
  assert.deepEqual(sorted.map((c) => c.id), ["code.3", "code.2", "code.1", "code.5", "code.4"]);
});

test("search covers label, issuer and website", () => {
  const list = [code("1", "octo", { issuer: "GitHub" }), code("2", "VPN", { website: "https://corp.example.com" }), code("3", "Bank")];
  assert.deepEqual(matchingCodes(list, "git").map((c) => c.id), ["code.1"]);
  assert.deepEqual(matchingCodes(list, "corp").map((c) => c.id), ["code.2"]);
  assert.deepEqual(matchingCodes(list, "").length, 3);
  assert.deepEqual(matchingCodes(list, "nothing"), []);
  assert.deepEqual(matchingCodes([code("4", "Soci\u00e9t\u00e9 G\u00e9n\u00e9rale")], "societe").map((c) => c.id), ["code.4"], "accents don't matter");
});

test("a read QR or link names the code from its account and issuer, without repeating them", () => {
  assert.deepEqual(codeLabels({ issuer: "GitHub", account: "octo" }), { label: "octo", issuer: "GitHub" });
  assert.deepEqual(codeLabels({ issuer: "GitHub", account: "" }), { label: "GitHub", issuer: "" });
  assert.deepEqual(codeLabels({ issuer: "Steam", account: "steam" }), { label: "steam", issuer: "" });
  assert.deepEqual(codeLabels({ issuer: "", account: "" }), { label: "", issuer: "" });
});

test("a thousand codes sort and search quickly", () => {
  const many = Array.from({ length: 1000 }, (_, i) => code(String(i), `Account ${i}`, { issuer: i % 2 ? "GitHub" : "Google" }));
  const started = performance.now();
  const sorted = sortedCodes(many);
  const found = matchingCodes(sorted, "github 99");
  assert.ok(performance.now() - started < 50);
  assert.ok(found.length > 0 && found.every((c) => c.issuer === "GitHub"));
});
