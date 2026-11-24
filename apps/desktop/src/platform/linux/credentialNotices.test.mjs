import assert from "node:assert/strict";
import test from "node:test";
import { credentialNotice, credentialNoticeTitle, credentialStorage } from "../../credentialNotices.ts";

test("status names the key provider and warns when a configured keyring silently fell back", () => {
  const keyring = { passwords: { available: true }, reauth: true, backend: "gnome-libsecret", protection: "keyring", protectionFallback: false, storage: "the Secret Service keyring" };
  assert.equal(credentialNotice(keyring, "passwords"), null);
  assert.equal(credentialStorage(keyring, "passwords"),
    "Saved separately for each profile and encrypted with a key from the Secret Service keyring. Showing, changing or exporting them asks for your system password (polkit).");
  assert.equal(credentialStorage({ ...keyring, storage: "KWallet" }, "autofill"),
    "Card numbers are encrypted with a key from KWallet. Showing one asks for your system password (polkit).");
  const fallback = { ...keyring, protection: "obfuscated", protectionFallback: true, storage: "Chromium's built-in key, which only obfuscates" };
  assert.match(credentialNotice(fallback, "passwords"), /keyring didn't answer/);
  assert.match(credentialNotice(fallback, "passwords"), /only obfuscates new passwords/);
  assert.match(credentialNotice({ ...fallback, addresses: { available: true }, cards: { available: true } }, "autofill"), /only obfuscates new card numbers/);
  assert.equal(credentialNoticeTitle(fallback, "passwords"), "Passwords aren't encrypted with your keyring");
  assert.equal(credentialNoticeTitle(fallback, "autofill"), "Card numbers aren't encrypted with your keyring");
  assert.match(credentialStorage(fallback, "passwords"), /protected only by Chromium's built-in key, which only obfuscates/);
  const basic = { ...keyring, backend: "basic", protection: "obfuscated", protectionFallback: false, storage: "Chromium's basic store, which only obfuscates" };
  assert.doesNotMatch(credentialNotice(basic, "passwords"), /keyring didn't answer/);
  assert.match(credentialNotice(basic, "passwords"), /basic password store/);
  assert.equal(credentialNoticeTitle(basic, "passwords"), "Passwords aren't encrypted with your keyring");
  assert.equal(credentialNoticeTitle({ ...keyring, passwords: { available: false, message: "x" } }, "passwords"), "Passwords are unavailable");
  assert.equal(credentialNoticeTitle({ ...keyring, reauth: false }, "passwords"), "System authentication is unavailable");
  assert.equal(credentialNoticeTitle({ ...keyring, addresses: { available: true }, cards: { available: false, message: "y" } }, "autofill"), "Some autofill data is unavailable");
  assert.match(credentialStorage({ ...keyring, protection: "none", storage: "no encryption key" }, "passwords"), /no encryption key is available/);
  assert.equal(credentialStorage({ ...keyring, protection: undefined, storage: undefined }, "passwords"), null);
  const unknown = { ...keyring, protection: "unknown", storage: "an unknown key" };
  assert.equal(credentialStorage(unknown, "passwords"), "Ardia couldn't check which key protects saved passwords, so whether they're encrypted is unknown.");
  assert.equal(credentialStorage(unknown, "autofill"), "Ardia couldn't check which key protects card numbers, so whether they're encrypted is unknown.");
  for (const text of [credentialStorage(keyring, "passwords"), credentialStorage(keyring, "autofill"), credentialNotice(fallback, "passwords")]) {
    assert.doesNotMatch(text, /Mac|Keychain|Touch ID/);
  }
});
