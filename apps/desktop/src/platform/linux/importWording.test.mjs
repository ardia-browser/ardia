import assert from "node:assert/strict";
import test from "node:test";
import { unlockCopy, unlockFailure } from "../../importUnlock.ts";

const CHROME = { id: "chrome", name: "Google Chrome", family: "chromium", needsKeychain: true, keychainService: "Chrome Safe Storage", profiles: [{ id: "Default" }, { id: "Profile 1" }] };
const FIREFOX = {
  id: "firefox", name: "Firefox", family: "firefox", needsKeychain: true,
  profiles: [{ id: "locked.default", needsPrimaryPassword: true }, { id: "plain.default" }, { id: "cards.default", cardsNeedKeyring: true }],
};
const MACOS = /\bMac\b|macOS|Keychain|keychain|iCloud|Touch ID/;

test("the Linux unlock step names the system keyring, never the Mac or its keychain", () => {
  const one = unlockCopy(CHROME, ["Default"], ["passwords"]);
  const many = unlockCopy(CHROME, ["Default", "Profile 1"], ["passwords"]);
  for (const copy of [one, many, unlockCopy(FIREFOX, ["locked.default"], ["passwords"]), unlockCopy(FIREFOX, ["cards.default"], ["autofill"])]) {
    for (const text of [copy.title, copy.subtitle, copy.lead, copy.detail, copy.waiting]) assert.doesNotMatch(text, MACOS);
  }
  assert.match(one.detail, /Secret Service or KWallet/);
  assert.match(one.detail, /“Chrome Safe Storage”/);
  assert.match(many.lead, /once for each selected profile/);
  assert.equal(one.field, false);
  for (const code of ["locked", "denied", "notFound", "unavailable", "timeout", "cancelled", "unreadable", undefined]) {
    for (const source of [CHROME, FIREFOX]) assert.doesNotMatch(unlockFailure(source, code), MACOS);
  }
  assert.match(unlockFailure(CHROME, "locked"), /system keyring is locked/);
  assert.match(unlockFailure(CHROME, "denied"), /didn't allow access to Chrome Safe Storage/);
  assert.match(unlockFailure(CHROME, "notFound"), /has no Chrome Safe Storage key/);
  assert.match(unlockFailure(CHROME, "unavailable"), /Secret Service or KWallet/);
  assert.match(unlockFailure(FIREFOX, "denied"), /isn't Firefox's primary password/);
});
