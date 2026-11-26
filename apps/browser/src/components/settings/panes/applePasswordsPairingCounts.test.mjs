import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const native = await import("../../../test-native/ardiacore.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../../../state/telemetry/client.ts");
client.loadChoice();
after(() => client.setSharing(false, "settings"));
const { useBrowser } = await import("../../../state/browser/store.ts");
const ap = await import("../../../state/site/applePasswords.ts");
const { takePasswordManagerCounts } = await import("../../../state/telemetry/passwordManagerCounts.ts");

const S = () => useBrowser.getState();
const pairingCounts = (counts) => Object.fromEntries(Object.entries(counts).filter(([field, n]) => field.startsWith("apple_passwords_pairing") && n));

async function pairWith(...codes) {
  S().hydrate({});
  S().createWindow({ url: "https://a.test/" });
  native.applePasswords.state = "notConnected";
  await ap.loadApplePasswords();
  await ap.startApplePasswordsPairing(S().settings.defaultProfileId);
  for (const code of codes) await ap.submitApplePasswordsCode(code);
}

test("Pairing counts starts, Pairings and each kind of failure while sharing is on, and nothing while it is off", async () => {
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  await pairWith("000000", native.applePasswords.code);
  assert.deepEqual(pairingCounts(takePasswordManagerCounts()), {
    apple_passwords_pairings_started: 1,
    apple_passwords_pairings_paired: 1,
    apple_passwords_pairings_failed: 1,
    apple_passwords_pairing_failures_wrong_code: 1,
  });
  client.setSharing(false, "settings");
  await pairWith(native.applePasswords.code);
  assert.deepEqual(pairingCounts(takePasswordManagerCounts()), {});
});

test("every Pairing failure kind has its own field, sent as zero when nothing happened", () => {
  const fields = Object.keys(takePasswordManagerCounts()).filter((field) => field.startsWith("apple_passwords_pairing_failures_"));
  assert.deepEqual(fields.sort(), [
    "apple_passwords_pairing_failures_failed",
    "apple_passwords_pairing_failures_helper_missing",
    "apple_passwords_pairing_failures_not_entitled",
    "apple_passwords_pairing_failures_refused",
    "apple_passwords_pairing_failures_too_old",
    "apple_passwords_pairing_failures_wrong_code",
  ]);
});
