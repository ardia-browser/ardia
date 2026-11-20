import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetPending, keepListedPending, pendingFor, PENDING_TOTP_MS, rememberPending } from "./pendingTotp.ts";

const at = 1_000_000;
const entry = (origin, id, when = at, provider = "1password", tabId = "t1") => ({ origin, tabId, provider, id, at: when });

test("nothing is pending for another site, or once three minutes have passed", () => {
  const list = rememberPending([], entry("https://example.com", "a"));
  assert.equal(pendingFor(list, "https://example.org", "t1", at + 1), null);
  assert.equal(pendingFor(list, "https://example.com", "t1", at + PENDING_TOTP_MS), null);
  assert.equal(pendingFor(list, "https://example.com", "t1", at + PENDING_TOTP_MS + 1), null);
  assert.equal(pendingFor(list, "https://example.com", "t1", at - 1), null);
});

test("a fill is pending only for its exact origin in the tab that filled it", () => {
  const list = rememberPending([], entry("https://login.example.com", "a"));
  assert.equal(pendingFor(list, "https://login.example.com", "t1", at + PENDING_TOTP_MS - 1)?.id, "a");
  assert.equal(pendingFor(list, "https://evil.example.com", "t1", at), null, "a sibling subdomain can't take the code");
  assert.equal(pendingFor(list, "https://example.com", "t1", at), null, "nor the parent domain");
  assert.equal(pendingFor(list, "https://login.example.com", "t2", at), null, "nor another tab on the same origin");
  assert.equal(pendingFor(list, "https://login.example.com", null, at), null, "nor a menu that doesn't know its tab");
});

test("a newer fill in the same tab replaces the older one, other tabs keep theirs", () => {
  let list = rememberPending([], entry("https://example.com", "old"));
  list = rememberPending(list, entry("https://other.test", "other", at + 10, "1password", "t2"));
  list = rememberPending(list, entry("https://example.com", "new", at + 20));
  assert.equal(list.length, 2);
  assert.equal(pendingFor(list, "https://example.com", "t1", at + 30)?.id, "new");
  assert.equal(pendingFor(list, "https://other.test", "t2", at + 30)?.id, "other");
});

test("expired entries are dropped when something new is remembered", () => {
  const list = rememberPending([entry("https://old.test", "x")], entry("https://new.test", "y", at + PENDING_TOTP_MS + 5));
  assert.deepEqual(list.map((p) => p.id), ["y"]);
});

test("locking a manager forgets its pending codes, signing out of everything forgets all", () => {
  const list = [entry("https://a.test", "a", at, "1password"), entry("https://b.test", "b", at, "bitwarden")];
  assert.deepEqual(forgetPending(list, "1password").map((p) => p.id), ["b"]);
  assert.deepEqual(forgetPending(list), []);
  assert.deepEqual(keepListedPending(list, "bitwarden", new Set()).map((p) => p.id), ["a"]);
});
