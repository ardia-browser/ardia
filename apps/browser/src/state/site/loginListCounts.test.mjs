import assert from "node:assert/strict";
import { after, test } from "node:test";

const native = await import("../../test-native/ardiacore.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
client.loadChoice();
after(() => client.setSharing(false, "settings"));
const { takePasswordManagerCounts } = await import("../telemetry/passwordManagerCounts.ts");
const { startLoginListCounts } = await import("./loginListCounts.ts");

const listCounts = (counts) => Object.fromEntries(Object.entries(counts).filter(([field]) => /^apple_passwords_(login_list|fills)/.test(field)));
const counted = (name) => native.emitEvent("passwords.loginListCounted", { name, epoch: client.consentEpoch() });

test("the Login list counts each time it is shown, each fill and each fill that failed, only while sharing is on", () => {
  startLoginListCounts();
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  for (const name of ["shown", "shown", "filled", "fillFailed"]) counted(name);
  assert.deepEqual(listCounts(takePasswordManagerCounts()), {
    apple_passwords_login_list_shown: 2,
    apple_passwords_login_list_filled: 1,
    apple_passwords_fills_failed: 1,
    apple_passwords_login_list_connect_shown: 0,
    apple_passwords_login_list_connect_picked: 0,
    apple_passwords_login_list_not_now: 0,
  });
  client.setSharing(false, "settings");
  counted("shown");
  assert.deepEqual(listCounts(takePasswordManagerCounts()), {
    apple_passwords_login_list_shown: 0,
    apple_passwords_login_list_filled: 0,
    apple_passwords_fills_failed: 0,
    apple_passwords_login_list_connect_shown: 0,
    apple_passwords_login_list_connect_picked: 0,
    apple_passwords_login_list_not_now: 0,
  });
});

test("the Login list counts each Connect Apple Passwords row shown, each Connect picked and each Not now", () => {
  startLoginListCounts();
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  for (const name of ["connectShown", "connectShown", "connectShown", "connectPicked", "notNow"]) counted(name);
  const counts = takePasswordManagerCounts();
  assert.equal(counts.apple_passwords_login_list_connect_shown, 3);
  assert.equal(counts.apple_passwords_login_list_connect_picked, 1);
  assert.equal(counts.apple_passwords_login_list_not_now, 1);
  client.setSharing(false, "settings");
});

test("each login saved to Apple Passwords and each save it refused are counted, only while sharing is on", () => {
  const saveCounts = (counts) => Object.fromEntries(Object.entries(counts).filter(([field]) => /^apple_passwords_saves/.test(field)));
  const saved = (name) => native.emitEvent("passwords.applePasswordsSaveCounted", { name, epoch: client.consentEpoch() });
  startLoginListCounts();
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  for (const name of ["saved", "saved", "saveFailed"]) saved(name);
  assert.deepEqual(saveCounts(takePasswordManagerCounts()), { apple_passwords_saves_saved: 2, apple_passwords_saves_failed: 1 });
  client.setSharing(false, "settings");
  saved("saved");
  assert.deepEqual(saveCounts(takePasswordManagerCounts()), { apple_passwords_saves_saved: 0, apple_passwords_saves_failed: 0 });
});
