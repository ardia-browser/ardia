import assert from "node:assert/strict";
import { test } from "node:test";
const native = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { changeGuardedVaultSetting, weakensVaultSecurity } = await import("./settingsGuard.ts");

const safe = { vaultAskBeforeFilling: true, vaultLockOnQuit: true, vaultLockOnScreenLock: true, vaultIdleLockMinutes: 30 };

test("turning a protection off or waiting longer to lock weakens it, the reverse doesn't", () => {
  assert.equal(weakensVaultSecurity(safe, { vaultAskBeforeFilling: false }), true);
  assert.equal(weakensVaultSecurity(safe, { vaultLockOnQuit: false }), true);
  assert.equal(weakensVaultSecurity(safe, { vaultLockOnScreenLock: false }), true);
  assert.equal(weakensVaultSecurity(safe, { vaultIdleLockMinutes: 60 }), true);
  assert.equal(weakensVaultSecurity(safe, { vaultIdleLockMinutes: 0 }), true, "Never is the longest wait");
  assert.equal(weakensVaultSecurity(safe, { vaultIdleLockMinutes: 5 }), false);
  assert.equal(weakensVaultSecurity({ ...safe, vaultIdleLockMinutes: 0 }, { vaultIdleLockMinutes: 60 }), false);
  assert.equal(weakensVaultSecurity({ ...safe, vaultAskBeforeFilling: false }, { vaultAskBeforeFilling: true }), false);
});

test("a weakening change waits for the owner and is dropped when they decline", async () => {
  const S = () => useBrowser.getState();
  S().hydrate({});
  S().updateSettings(safe);
  native.passwordsUnlock.answer = false;
  assert.equal(await changeGuardedVaultSetting({ vaultAskBeforeFilling: false }), false);
  assert.equal(S().settings.vaultAskBeforeFilling, true);
  native.passwordsUnlock.answer = true;
  assert.equal(await changeGuardedVaultSetting({ vaultIdleLockMinutes: 0 }), true);
  assert.equal(S().settings.vaultIdleLockMinutes, 0);
  native.passwordsUnlock.answer = false;
  assert.equal(await changeGuardedVaultSetting({ vaultIdleLockMinutes: 5 }), true, "a stronger setting needs no check");
  assert.equal(S().settings.vaultIdleLockMinutes, 5);
  native.passwordsUnlock.answer = true;
});
