import assert from "node:assert/strict";
import test from "node:test";
import { credentialNotice, credentialNoticeTitle, credentialStorage } from "../../credentialNotices.ts";

test("Windows names Windows Hello for reveals and never the keyring, polkit or the Mac", () => {
  const dpapi = { passwords: { available: true }, reauth: true, backend: "dpapi", protection: "keyring", protectionFallback: false, storage: "a key Windows keeps for your account" };
  assert.equal(credentialNotice(dpapi, "passwords"), null);
  assert.equal(credentialStorage(dpapi, "passwords"),
    "Saved separately for each profile and encrypted with a key from a key Windows keeps for your account. Showing, changing or exporting them asks for Windows Hello or your Windows password.");
  assert.equal(credentialStorage(dpapi, "autofill"),
    "Card numbers are encrypted with a key from a key Windows keeps for your account. Showing one asks for Windows Hello or your Windows password.");
  const fallback = { ...dpapi, protection: "obfuscated", protectionFallback: true, storage: "Chromium's built-in key, which only obfuscates" };
  assert.match(credentialNotice(fallback, "passwords"), /Windows didn't give Chromium its encryption key, so new passwords are only obfuscated/);
  assert.match(credentialNotice({ ...fallback, addresses: { available: true }, cards: { available: true } }, "autofill"), /new card numbers are only obfuscated/);
  assert.equal(credentialNoticeTitle(fallback, "passwords"), "Passwords aren't encrypted");
  assert.equal(credentialNoticeTitle(fallback, "autofill"), "Card numbers aren't encrypted");
  const basic = { ...dpapi, backend: "basic", protection: "obfuscated", protectionFallback: false, storage: "Chromium's basic store, which only obfuscates" };
  assert.match(credentialNotice(basic, "passwords"), /basic password store/);
  for (const text of [credentialStorage(dpapi, "passwords"), credentialStorage(dpapi, "autofill"), credentialNotice(fallback, "passwords"), credentialNotice(basic, "passwords"), credentialNoticeTitle(fallback, "passwords")]) {
    assert.doesNotMatch(text, /keyring|polkit|Secret Service|KWallet|Mac|Keychain|Touch ID/);
  }
});

test("Windows keeps the sync key in its own encrypted storage, so no keyring message appears", async () => {
  const { keyringMessage, SYNC_KEY_NOT_SAVED } = await import("../../syncKeyStore.ts");
  for (const keyStore of ["secretService", "dpapi", "file"]) {
    for (const state of ["locked", "unavailable", "ok"]) {
      assert.equal(keyringMessage({ keyStore, keyStoreStatus: state, lastKeyStatus: state }, false), null);
      assert.equal(keyringMessage({ keyStore, keyStoreStatus: state, lastKeyStatus: state }, true), null);
    }
  }
  assert.doesNotMatch(SYNC_KEY_NOT_SAVED, /keyring/);
});
