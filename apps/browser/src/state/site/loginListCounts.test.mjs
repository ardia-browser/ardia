import assert from "node:assert/strict";
import { after, test } from "node:test";

const native = await import("../../test-native/ardiacore.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
client.loadChoice();
after(() => client.setSharing(false, "settings"));
const { takePasswordManagerCounts } = await import("../telemetry/passwordManagerCounts.ts");
const { startLoginListCounts } = await import("./loginListCounts.ts");

const listCounts = (counts) => Object.fromEntries(Object.entries(counts).filter(([field]) => /^apple_passwords_(login_list|fills)/.test(field) && !/_(chromium|webkit)$/.test(field)));
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
    apple_passwords_login_list_fetch_failed: 0,
    apple_passwords_login_list_other_frame_ignored: 0,
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
    apple_passwords_login_list_fetch_failed: 0,
    apple_passwords_login_list_other_frame_ignored: 0,
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

test("each login sent to Apple Passwords to save and each send that failed are counted, only while sharing is on", () => {
  const saveCounts = (counts) => Object.fromEntries(Object.entries(counts).filter(([field]) => /^apple_passwords_saves/.test(field) && !/_(chromium|webkit)$/.test(field)));
  const saved = (name) => native.emitEvent("passwords.applePasswordsSaveCounted", { name, epoch: client.consentEpoch() });
  startLoginListCounts();
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  for (const name of ["saveSent", "saveSent", "saveFailed"]) saved(name);
  assert.deepEqual(saveCounts(takePasswordManagerCounts()), { apple_passwords_saves_sent: 2, apple_passwords_saves_failed: 1 });
  client.setSharing(false, "settings");
  saved("saveSent");
  assert.deepEqual(saveCounts(takePasswordManagerCounts()), { apple_passwords_saves_sent: 0, apple_passwords_saves_failed: 0 });
});

test("each key or hide the Login list ignored because it came from a frame that didn't open the list is counted, also by the tab's engine, only while sharing is on", () => {
  const inEngine = (name, engine) => native.emitEvent("passwords.loginListCounted", { name, engine, epoch: client.consentEpoch() });
  startLoginListCounts();
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  for (const [name, engine] of [["otherFrameIgnored", "webkit"], ["otherFrameIgnored", "webkit"], ["otherFrameIgnored", "chromium"]]) inEngine(name, engine);
  const counts = takePasswordManagerCounts();
  assert.equal(counts.apple_passwords_login_list_other_frame_ignored, 3);
  assert.equal(counts.apple_passwords_login_list_other_frame_ignored_webkit, 2);
  assert.equal(counts.apple_passwords_login_list_other_frame_ignored_chromium, 1);
  assert.equal(counts.apple_passwords_login_list_shown, 0, "an ignored key or hide is not a list shown");
  client.setSharing(false, "settings");
  inEngine("otherFrameIgnored", "webkit");
  assert.equal(takePasswordManagerCounts().apple_passwords_login_list_other_frame_ignored, 0);
});

test("each Login list count is also counted by the engine of the tab it was in, and an unknown engine counts only the total", () => {
  const inEngine = (name, engine) => native.emitEvent("passwords.loginListCounted", { name, engine, epoch: client.consentEpoch() });
  startLoginListCounts();
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  for (const [name, engine] of [["shown", "chromium"], ["shown", "chromium"], ["filled", "chromium"], ["shown", "webkit"], ["fillFailed", "webkit"], ["shown", "gecko"], ["notNow", "chromium"]]) inEngine(name, engine);
  const counts = takePasswordManagerCounts();
  assert.equal(counts.apple_passwords_login_list_shown, 4);
  assert.equal(counts.apple_passwords_login_list_shown_chromium, 2);
  assert.equal(counts.apple_passwords_login_list_shown_webkit, 1);
  assert.equal(counts.apple_passwords_login_list_filled_chromium, 1);
  assert.equal(counts.apple_passwords_login_list_filled_webkit, 0);
  assert.equal(counts.apple_passwords_fills_failed_webkit, 1);
  assert.equal(counts.apple_passwords_login_list_not_now_chromium, 1);
  assert.ok(!Object.keys(counts).some((field) => field.includes("gecko")), "no field for an engine Ardia doesn't have");
  client.setSharing(false, "settings");
});

test("each Apple Passwords save is also counted by the engine of the tab it came from, and an unknown engine counts only the total", () => {
  const savedIn = (name, engine) => native.emitEvent("passwords.applePasswordsSaveCounted", { name, engine, epoch: client.consentEpoch() });
  startLoginListCounts();
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  for (const [name, engine] of [["saveSent", "chromium"], ["saveSent", "chromium"], ["saveFailed", "chromium"], ["saveSent", "webkit"], ["saveSent", "gecko"]]) savedIn(name, engine);
  const counts = takePasswordManagerCounts();
  assert.equal(counts.apple_passwords_saves_sent, 4);
  assert.equal(counts.apple_passwords_saves_sent_chromium, 2);
  assert.equal(counts.apple_passwords_saves_sent_webkit, 1);
  assert.equal(counts.apple_passwords_saves_failed_chromium, 1);
  assert.equal(counts.apple_passwords_saves_failed_webkit, 0);
  assert.ok(!Object.keys(counts).some((field) => field.includes("gecko")), "no field for an engine Ardia doesn't have");
  client.setSharing(false, "settings");
});

test("each Verification code filled and each one Apple Passwords didn't fill are counted, also by the tab's engine, only while sharing is on", () => {
  const inEngine = (name, engine) => native.emitEvent("passwords.loginListCounted", { name, engine, epoch: client.consentEpoch() });
  startLoginListCounts();
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  for (const [name, engine] of [["codeFilled", "chromium"], ["codeFilled", "webkit"], ["codeFilled", "webkit"], ["codeFillFailed", "chromium"]]) inEngine(name, engine);
  const counts = takePasswordManagerCounts();
  assert.equal(counts.apple_passwords_codes_filled, 3);
  assert.equal(counts.apple_passwords_codes_filled_chromium, 1);
  assert.equal(counts.apple_passwords_codes_filled_webkit, 2);
  assert.equal(counts.apple_passwords_codes_failed, 1);
  assert.equal(counts.apple_passwords_codes_failed_chromium, 1);
  assert.equal(counts.apple_passwords_login_list_filled, 0, "a code is not a login fill");
  client.setSharing(false, "settings");
  inEngine("codeFilled", "webkit");
  assert.equal(takePasswordManagerCounts().apple_passwords_codes_filled, 0);
});

test("each strong password Ardia suggested and filled is counted, also by the tab's engine, only while sharing is on", () => {
  const inEngine = (name, engine) => native.emitEvent("passwords.loginListCounted", { name, engine, epoch: client.consentEpoch() });
  startLoginListCounts();
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  for (const [name, engine] of [["strongPasswordUsed", "chromium"], ["strongPasswordUsed", "webkit"], ["strongPasswordUsed", "webkit"]]) inEngine(name, engine);
  const counts = takePasswordManagerCounts();
  assert.equal(counts.apple_passwords_strong_passwords_used, 3);
  assert.equal(counts.apple_passwords_strong_passwords_used_chromium, 1);
  assert.equal(counts.apple_passwords_strong_passwords_used_webkit, 2);
  assert.equal(counts.apple_passwords_login_list_filled, 0, "a strong password is not a login fill");
  client.setSharing(false, "settings");
  inEngine("strongPasswordUsed", "webkit");
  assert.equal(takePasswordManagerCounts().apple_passwords_strong_passwords_used, 0);
});

test("story 63: each Login list fetch, fill, code and save failure is counted by its kind", () => {
  startLoginListCounts();
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  const epoch = client.consentEpoch();
  native.emitEvent("passwords.loginListCounted", { name: "listFailed", engine: "chromium", kind: "timedOut", epoch });
  native.emitEvent("passwords.loginListCounted", { name: "fillFailed", engine: "webkit", kind: "refused", epoch });
  native.emitEvent("passwords.loginListCounted", { name: "codeFillFailed", engine: "webkit", kind: "unreadable", epoch });
  native.emitEvent("passwords.applePasswordsSaveCounted", { name: "saveFailed", engine: "chromium", kind: "notPaired", epoch });
  native.emitEvent("passwords.loginListCounted", { name: "fillFailed", engine: "webkit", epoch });
  const counts = takePasswordManagerCounts();
  assert.equal(counts.apple_passwords_login_list_fetch_failed_chromium, 1);
  assert.equal(counts.apple_passwords_list_failures_timed_out, 1);
  assert.equal(counts.apple_passwords_fills_failed, 2, "a failure without a kind still counts as a failure");
  assert.equal(counts.apple_passwords_fill_failures_refused, 1);
  assert.equal(counts.apple_passwords_code_failures_unreadable, 1);
  assert.equal(counts.apple_passwords_save_failures_not_paired, 1);
  client.setSharing(false, "settings");
});
