import assert from "node:assert/strict";
import test from "node:test";
import { unlockCopy, unlockFailure } from "../../importUnlock.ts";

const CHROME = { id: "chrome", name: "Google Chrome", family: "chromium", needsKeychain: true, keychainService: "Chrome Safe Storage", profiles: [{ id: "Default" }, { id: "Profile 1" }] };
const FIREFOX = {
  id: "firefox", name: "Firefox", family: "firefox", needsKeychain: true,
  profiles: [{ id: "locked.default", needsPrimaryPassword: true }, { id: "plain.default" }, { id: "cards.default", cardsNeedKeyring: true }],
};
const MACOS = /\bMac\b|macOS|Keychain|keychain|iCloud|Touch ID/;

test("the Windows unlock step names Windows and your account, never the keyring, Secret Service, KWallet or the Mac", () => {
  const copies = [unlockCopy(CHROME, ["Default"], ["passwords"]), unlockCopy(CHROME, ["Default", "Profile 1"], ["passwords"]), unlockCopy(FIREFOX, ["locked.default"], ["passwords"]), unlockCopy(FIREFOX, ["cards.default"], ["autofill"])];
  const failures = ["locked", "denied", "notFound", "unavailable", "timeout", "cancelled", "unreadable", undefined].flatMap((code) => [CHROME, FIREFOX].map((source) => unlockFailure(source, code)));
  for (const text of [...copies.flatMap((copy) => [copy.title, copy.subtitle, copy.lead, copy.detail, copy.waiting]), ...failures]) {
    assert.doesNotMatch(text, /keyring|Secret Service|KWallet|polkit/i);
    assert.doesNotMatch(text, MACOS);
  }
  assert.match(copies[0].detail, /asks Windows for “Chrome Safe Storage”/);
  assert.match(copies[0].detail, /this PC/);
  assert.match(copies[1].lead, /each selected profile/);
  assert.match(copies[3].detail, /“Firefox Encrypted Storage”/);
  assert.match(unlockFailure(CHROME, "denied"), /Windows didn't allow access to Chrome Safe Storage/);
  assert.match(unlockFailure(CHROME, "notFound"), /Windows has no Chrome Safe Storage key/);
  assert.match(unlockFailure(FIREFOX, "denied"), /isn't Firefox's primary password/);
});
