import assert from "node:assert/strict";
import test from "node:test";
import { keyringMessage, presentSyncState, SYNC_KEY_NOT_SAVED } from "../../syncKeyStore.ts";

test("a Secret Service sync key that's locked or missing says how to open the keyring, and other stores stay quiet", () => {
  const status = (keyStore, state) => ({ keyStore, keyStoreStatus: state, lastKeyStatus: state });
  assert.match(keyringMessage(status("secretService", "unavailable"), false), /^No keyring is running.*GNOME Keyring or KWallet, or enter your recovery phrase\.$/);
  assert.match(keyringMessage(status("secretService", "unavailable"), true), /^Couldn’t save the sync key: no keyring is running\./);
  assert.equal(keyringMessage(status("secretService", "locked"), false), "Your keyring is locked. Unlock it, or enter your recovery phrase to keep syncing.");
  assert.equal(keyringMessage(status("secretService", "locked"), true), "Couldn’t save the sync key: your keyring is locked. Unlock it and try again.");
  assert.equal(keyringMessage(status("secretService", "ok"), false), null);
  assert.equal(keyringMessage(status("file", "locked"), false), null);
  assert.equal(keyringMessage(null, false), null);
  assert.equal(keyringMessage({ keyStore: "secretService", keyStoreStatus: "ok", lastKeyStatus: "locked" }, true), "Couldn’t save the sync key: your keyring is locked. Unlock it and try again.");
  assert.equal(SYNC_KEY_NOT_SAVED, "Couldn’t save the sync key in your keyring.");
});

test("a locked sync shows the keyring's reason, and any other state passes through", () => {
  const locked = { status: "locked", error: null };
  assert.equal(presentSyncState(locked, { keyStore: "secretService", keyStoreStatus: "locked", lastKeyStatus: "locked" }).error, "Your keyring is locked. Unlock it, or enter your recovery phrase to keep syncing.");
  assert.equal(presentSyncState(locked, { keyStore: "file", keyStoreStatus: "locked", lastKeyStatus: "locked" }), locked);
  const idle = { status: "idle", error: null };
  assert.equal(presentSyncState(idle, { keyStore: "secretService", keyStoreStatus: "locked", lastKeyStatus: "locked" }), idle);
});
