import assert from "node:assert/strict";
import { test } from "node:test";
import { ardiaLoginId, editOf, existingLogin, loginFormProblem, normalizeWebsite } from "./loginForm.ts";

test("a bare domain becomes an https origin, and paths, queries and case drop away", () => {
  assert.equal(normalizeWebsite("github.com"), "https://github.com");
  assert.equal(normalizeWebsite("  https://GitHub.com/login?next=1 "), "https://github.com");
  assert.equal(normalizeWebsite("example.com:8443/x"), "https://example.com:8443");
  assert.equal(normalizeWebsite("http://localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeWebsite("localhost:3000"), "https://localhost:3000");
});

test("junk and insecure websites are refused", () => {
  for (const bad of ["", "   ", "http://example.com", "ftp://example.com", "javascript:alert(1)", "not a site", "example", "user:pw@evil.com", "https://", "..com", "https://exa mple.com"]) {
    assert.equal(normalizeWebsite(bad), null, bad);
  }
});

const saved = [
  { origin: "https://github.com", username: "octo" },
  { origin: "https://github.com/", username: "" },
];

test("the same site and username is a duplicate, case of the host and a trailing slash don't matter", () => {
  assert.deepEqual(existingLogin(saved, "https://GitHub.com", "octo"), saved[0]);
  assert.deepEqual(existingLogin(saved, "https://github.com", ""), saved[1]);
  assert.equal(existingLogin(saved, "https://github.com", "Octo"), null, "usernames are compared exactly, as Chrome does");
  assert.equal(existingLogin(saved, "https://gist.github.com", "octo"), null);
});

test("an edit may keep its own site and username without counting as a duplicate", () => {
  assert.equal(existingLogin(saved, "https://github.com", "octo", saved[0]), null);
});

test("the form names the one thing that blocks Save", () => {
  const ok = { mode: "password", website: "github.com", username: "me", passwordLength: 8, saved: [] };
  assert.equal(loginFormProblem(ok), null);
  assert.equal(loginFormProblem({ ...ok, website: "" }), "website");
  assert.equal(loginFormProblem({ ...ok, website: "http://x.com" }), "website");
  assert.equal(loginFormProblem({ ...ok, passwordLength: 0 }), "password");
  assert.equal(loginFormProblem({ ...ok, saved: [{ origin: "https://github.com", username: "me" }] }), "duplicate");
  assert.equal(loginFormProblem({ mode: "code", website: "", label: "VPN", hasCode: true, saved: [] }), null);
  assert.equal(loginFormProblem({ mode: "code", website: "", label: "  ", hasCode: true, saved: [] }), "label");
  assert.equal(loginFormProblem({ mode: "code", website: "", label: "VPN", hasCode: false, saved: [] }), "code");
  assert.equal(loginFormProblem({ mode: "code", website: "junk", label: "VPN", hasCode: true, saved: [] }), "website");
});

test("an edit sends only what changed", () => {
  const was = { website: "https://github.com", username: "octo" };
  assert.deepEqual(editOf(was, { website: "github.com", username: "octo" }), {});
  assert.deepEqual(editOf(was, { website: "github.com", username: "octo2" }), { username: "octo2" });
  assert.deepEqual(editOf(was, { website: "https://gitlab.com/", username: "octo" }), { url: "https://gitlab.com" });
  assert.deepEqual(editOf(was, { website: "github.com", username: "octo", passwordDraft: "t" }), { passwordDraft: "t" });
  assert.deepEqual(editOf(was, { website: "github.com", username: "octo", codeToken: "c" }), { totp: { token: "c" } });
  assert.deepEqual(editOf(was, { website: "github.com", username: "octo", removeCode: true }), { totp: { remove: true } });
});

test("an Ardia login's id matches the native key: base64url of profile, origin and username", () => {
  const id = ardiaLoginId("", "https://example.com/", "me");
  assert.equal(id, Buffer.from("\nhttps://example.com\nme").toString("base64url"));
  assert.equal(ardiaLoginId("Default", "https://bücher.de", "jö"), Buffer.from("Default\nhttps://bücher.de\njö").toString("base64url"));
});
