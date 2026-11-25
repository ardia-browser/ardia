import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { KEYRING_PROBE_DELAY_MS, probeKeyringAfterLaunch } from "./keyringProbe.ts";
import { keyringObserver, noteSyncKeyStore } from "./syncKeyringCounts.ts";
import { takeKeyringCounts } from "../../browser/src/state/telemetry/keyringCounts.ts";
import { consentToken, setConsentPeriod } from "../../browser/src/state/telemetry/consentPeriod.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const nonzero = (counts) => Object.fromEntries(Object.entries(counts).filter(([, n]) => n));
const status = (keyStoreStatus, lastKeyStatus = "ok") => ({ keyStore: "secretService", keyStoreStatus, lastKeyStatus, unlocked: false, unreadable: false, passwords: true });

function passwordsHost() {
  const calls = [];
  return {
    calls,
    bootstrap: { windowId: "w1", profileId: "default", capabilities: ["ArdiaPasswords.status"] },
    call: async () => "{}",
    invoke: async (method) => (calls.push(method), { protection: "keyring", passwords: null }),
    onEvent: () => () => {},
  };
}

function heldTimer() {
  const held = [];
  return { wait: (run, ms) => held.push({ run, ms }), held };
}

beforeEach(() => {
  setConsentPeriod(false, null);
  noteSyncKeyStore(null, null);
  takeKeyringCounts();
});

test("the keyring probe counts its check in the consent period it started in", async () => {
  setConsentPeriod(true, "probe-period");
  const timer = heldTimer();
  const host = passwordsHost();
  probeKeyringAfterLaunch(host, timer.wait);
  assert.equal(timer.held.length, 1);
  assert.equal(timer.held[0].ms, KEYRING_PROBE_DELAY_MS);
  timer.held[0].run();
  await settle();
  assert.deepEqual(host.calls, ["ArdiaPasswords.status"]);
  assert.deepEqual(nonzero(takeKeyringCounts()), { keyring_checks: 1, keyring_protection_keyring: 1 });
});

test("sharing turned off and on again during the probe's delay drops its result", async () => {
  setConsentPeriod(true, "first-period");
  const timer = heldTimer();
  const host = passwordsHost();
  probeKeyringAfterLaunch(host, timer.wait);
  setConsentPeriod(false, null);
  setConsentPeriod(true, "second-period");
  timer.held[0].run();
  await settle();
  assert.deepEqual(host.calls, []);
  assert.deepEqual(nonzero(takeKeyringCounts()), {});
});

test("a probe started with sharing off never schedules, even if sharing turns on before the delay ends", () => {
  const timer = heldTimer();
  probeKeyringAfterLaunch(passwordsHost(), timer.wait);
  assert.deepEqual(timer.held, []);
});

test("a failed sync-key save reported only through lastKeyStatus counts once per failure", () => {
  setConsentPeriod(true, "save-period");
  const consent = consentToken();
  noteSyncKeyStore(status("ok", "locked"), consent);
  noteSyncKeyStore(status("ok", "locked"), consent);
  assert.deepEqual(nonzero(takeKeyringCounts()), { keyring_sync_locked: 1 });
  noteSyncKeyStore(status("ok", "unavailable"), consent);
  assert.deepEqual(nonzero(takeKeyringCounts()), { keyring_sync_unavailable: 1 });
  noteSyncKeyStore(status("ok", "ok"), consent);
  noteSyncKeyStore(status("ok", "locked"), consent);
  assert.deepEqual(nonzero(takeKeyringCounts()), { keyring_sync_locked: 1 });
});

test("the key store's own state wins over lastKeyStatus, and a file key store never counts", () => {
  setConsentPeriod(true, "store-period");
  const consent = consentToken();
  noteSyncKeyStore(status("unavailable", "locked"), consent);
  noteSyncKeyStore({ ...status("locked", "locked"), keyStore: "file" }, consent);
  assert.deepEqual(nonzero(takeKeyringCounts()), { keyring_sync_unavailable: 1 });
});

test("a stopped keyring watcher's late observation is counted under its own consent, not a replacement watcher's", async () => {
  setConsentPeriod(true, "old-watcher");
  let answer;
  const stale = keyringObserver(() => new Promise((resolve) => (answer = resolve)), consentToken);
  const pending = stale.status();
  setConsentPeriod(false, null);
  setConsentPeriod(true, "new-watcher");
  const replacement = keyringObserver(async () => status("ok"), consentToken);
  await replacement.status();
  answer(status("locked"));
  stale.note(await pending);
  assert.deepEqual(nonzero(takeKeyringCounts()), {});
  replacement.note(status("locked"));
  assert.deepEqual(nonzero(takeKeyringCounts()), { keyring_sync_locked: 1 });
});
