import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HOSTILE_VALUES } from "../../../../../scripts/security/hostile-inputs.mjs";

const native = await import("../../test-native/ardiacore.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
client.loadChoice();
after(() => client.setSharing(false, "settings"));
const { consentToken } = await import("./consentPeriod.ts");
const counts = await import("./passwordManagerCounts.ts");
const { noteWebKitAutofillCount, takeWebKitAutofillCounts } = await import("./webKitAutofillCounts.ts");
const { passwordManagerProfileCounts } = await import("../site/passwordManagerChoice.ts");
const { startLoginListCounts } = await import("../site/loginListCounts.ts");
const { WHATS_SENT } = await import("./copy.ts");

const FEATURE = /^(apple_passwords_|me_card_|onboarding_offers_|icloud_extension_|webkit_autofill_me_card_)|^password_manager_(chose|profiles)_apple$/;

const ENGINES = "each of those also counted by whether the tab was a Chromium or a WebKit one";
const FEATURE_COUNTS = {
  apple_passwords_login_list_shown: "how many times the Login list showed Apple Passwords logins",
  apple_passwords_login_list_filled: "how many of those filled a login",
  apple_passwords_fills_failed: "how many fills Apple Passwords didn't allow",
  apple_passwords_login_list_connect_shown: "how many times it offered Connect Apple Passwords after the connection ended",
  apple_passwords_login_list_connect_picked: "how many times you picked Connect there",
  apple_passwords_login_list_not_now: "how many times you picked Not now",
  apple_passwords_login_list_other_frame_ignored: "how many times it ignored a key or a close from a frame that didn't open it",
  apple_passwords_codes_filled: "how many Verification codes it filled",
  apple_passwords_codes_failed: "how many Verification codes it filled and how many it couldn't",
  apple_passwords_strong_passwords_used: "how many strong passwords it suggested and filled",
  apple_passwords_saves_sent: "how many logins Ardia asked Apple Passwords to save",
  apple_passwords_saves_failed: "how many it couldn't ask",
  apple_passwords_pairings_started: "how many times you started connecting Apple Passwords",
  apple_passwords_pairings_paired: "how many of those connected",
  apple_passwords_pairings_failed: "how many didn't and why",
  apple_passwords_pairing_failures_wrong_code: "a wrong code",
  apple_passwords_pairing_failures_failed: "no answer",
  apple_passwords_pairing_failures_refused: "Apple's helper was refused or is missing",
  apple_passwords_pairing_failures_helper_missing: "Apple's helper was refused or is missing",
  apple_passwords_pairing_failures_too_old: "the system is too old",
  apple_passwords_pairing_failures_not_entitled: "this copy of Ardia can't use it",
  me_card_turned_on: "how many times you turned on Use my Me card from Contacts",
  me_card_access_refused: "how many times Contacts access wasn't allowed",
  onboarding_offers_apple_passwords_accepted: "how many times you took or turned down onboarding's offers of Apple Passwords and of your Me card",
  onboarding_offers_apple_passwords_declined: "how many times you took or turned down onboarding's offers of Apple Passwords and of your Me card",
  onboarding_offers_me_card_accepted: "how many times you took or turned down onboarding's offers of Apple Passwords and of your Me card",
  onboarding_offers_me_card_declined: "how many times you took or turned down onboarding's offers of Apple Passwords and of your Me card",
  icloud_extension_turned_off: "how many times picking Apple Passwords turned Apple's own Passwords extension off",
  icloud_extension_turned_back_on: "how many times you turned it back on",
  icloud_extension_restored: "how many times switching away turned it back on",
  icloud_extension_failures: "how many times Ardia couldn't change it",
  password_manager_chose_apple: "how many times you picked Ardia, Apple Passwords, None or a plugin as a profile's password manager",
  webkit_autofill_me_card_fills: "how many of those addresses came from your Me card",
  apple_passwords_login_list_fetch_failed: "how many times the Login list couldn't get the site's logins from Apple Passwords",
  me_card_fills_chromium: "how many times your Me card filled a form in a Chromium tab",
};
const KINDS = { notPaired: "not_paired", refused: "refused", helperMissing: "helper_missing", timedOut: "timed_out", unreadable: "unreadable" };
const WHY = "each of those failures also counted by why (not connected, refused, Apple's helper missing, no answer in time, or an answer Ardia couldn't read)";
const KIND_CATEGORIES = { listFailed: "list", fillFailed: "fill", codeFillFailed: "code" };
for (const category of [...Object.values(KIND_CATEGORIES), "save"]) for (const kind of Object.values(KINDS)) FEATURE_COUNTS[`apple_passwords_${category}_failures_${kind}`] = WHY;
const BY_ENGINE = [
  "apple_passwords_login_list_shown", "apple_passwords_login_list_filled", "apple_passwords_fills_failed", "apple_passwords_login_list_connect_shown",
  "apple_passwords_login_list_connect_picked", "apple_passwords_login_list_not_now", "apple_passwords_codes_filled", "apple_passwords_codes_failed",
  "apple_passwords_strong_passwords_used", "apple_passwords_saves_sent", "apple_passwords_saves_failed", "apple_passwords_login_list_fetch_failed",
  "apple_passwords_login_list_other_frame_ignored",
];
for (const field of BY_ENGINE) for (const engine of ["chromium", "webkit"]) FEATURE_COUNTS[`${field}_${engine}`] = ENGINES;
const SNAPSHOT_COUNTS = { password_manager_profiles_apple: "how many of your profiles use Ardia's password manager, Apple Passwords, none or a password manager plugin" };

const OTHER_PASSWORD_MANAGER_COUNTS = [
  "password_manager_chose_ardia", "password_manager_chose_none", "password_manager_chose_plugin", "password_manager_offer_to_save_restore_failures",
  "password_manager_offer_to_save_restored", "password_manager_panel_hints_dismissed", "password_manager_panel_hints_shown", "password_manager_panel_opens_badge",
  "password_manager_panel_opens_menu", "password_manager_panel_refusal_hidden", "password_manager_panel_refusal_no_panel", "password_manager_panel_refusal_not_editing",
  "password_manager_panel_refusal_not_focused", "password_manager_panel_refusal_not_key", "password_manager_panel_refusal_refused", "password_manager_panel_refusal_throttled",
  "password_manager_panel_refusal_unavailable", "password_manager_panel_refused_badge", "password_manager_panel_refused_menu", "password_manager_profiles_moved_back",
  "password_manager_record_failed", "verification_code_setups_accepted", "verification_code_setups_failed", "verification_code_setups_offered",
];
const OTHER_WEBKIT_AUTOFILL_COUNTS = [
  "webkit_autofill_address_fills", "webkit_autofill_address_save_offers", "webkit_autofill_address_saves", "webkit_autofill_card_fills",
  "webkit_autofill_card_reauths_refused", "webkit_autofill_card_save_offers", "webkit_autofill_card_saves", "webkit_autofill_save_suppressed",
];
const OTHER_SNAPSHOT_COUNTS = ["password_manager_profiles_ardia", "password_manager_profiles_none", "password_manager_profiles_plugin"];

const LOGIN_LIST = {
  shown: "apple_passwords_login_list_shown", filled: "apple_passwords_login_list_filled", fillFailed: "apple_passwords_fills_failed",
  connectShown: "apple_passwords_login_list_connect_shown", connectPicked: "apple_passwords_login_list_connect_picked", notNow: "apple_passwords_login_list_not_now",
  codeFilled: "apple_passwords_codes_filled", codeFillFailed: "apple_passwords_codes_failed", strongPasswordUsed: "apple_passwords_strong_passwords_used",
  listFailed: "apple_passwords_login_list_fetch_failed", otherFrameIgnored: "apple_passwords_login_list_other_frame_ignored",
};
const SAVES = { saveSent: "apple_passwords_saves_sent", saveFailed: "apple_passwords_saves_failed" };
const PAIRING_FAILURES = {
  wrongCode: "apple_passwords_pairing_failures_wrong_code", failed: "apple_passwords_pairing_failures_failed", refused: "apple_passwords_pairing_failures_refused",
  helperMissing: "apple_passwords_pairing_failures_helper_missing", tooOld: "apple_passwords_pairing_failures_too_old", notEntitled: "apple_passwords_pairing_failures_not_entitled",
};

const NOTES = [
  ...Object.entries(LOGIN_LIST).flatMap(([name, field]) => [
    [`noteLoginList ${name}`, (c) => counts.noteLoginList(name, undefined, c), [field]],
    ...["chromium", "webkit"].map((engine) => [`noteLoginList ${name} ${engine}`, (c) => counts.noteLoginList(name, engine, c), [field, `${field}_${engine}`]]),
  ]),
  ...Object.entries(SAVES).flatMap(([name, field]) => [
    [`noteApplePasswordsSave ${name}`, (c) => counts.noteApplePasswordsSave(name, undefined, c), [field]],
    ...["chromium", "webkit"].map((engine) => [`noteApplePasswordsSave ${name} ${engine}`, (c) => counts.noteApplePasswordsSave(name, engine, c), [field, `${field}_${engine}`]]),
  ]),
  ["noteApplePasswordsPairing started", (c) => counts.noteApplePasswordsPairing("started", c), ["apple_passwords_pairings_started"]],
  ["noteApplePasswordsPairing paired", (c) => counts.noteApplePasswordsPairing("paired", c), ["apple_passwords_pairings_paired"]],
  ...Object.entries(PAIRING_FAILURES).map(([kind, field]) => [`noteApplePasswordsPairingFailed ${kind}`, (c) => counts.noteApplePasswordsPairingFailed(kind, c), ["apple_passwords_pairings_failed", field]]),
  ["noteMeCardSwitch on", (c) => counts.noteMeCardSwitch("on", c), ["me_card_turned_on"]],
  ["noteMeCardSwitch refused", (c) => counts.noteMeCardSwitch("refused", c), ["me_card_access_refused"]],
  ...["applePasswords", "meCard"].flatMap((offer) =>
    ["accepted", "declined"].map((answer) => [`noteOnboardingOffer ${offer} ${answer}`, (c) => counts.noteOnboardingOffer(offer, answer, c), [`onboarding_offers_${offer === "meCard" ? "me_card" : "apple_passwords"}_${answer}`]]),
  ),
  ["noteICloudExtension turnedOff", (c) => counts.noteICloudExtension("turnedOff", c), ["icloud_extension_turned_off"]],
  ["noteICloudExtension turnedBackOn", (c) => counts.noteICloudExtension("turnedBackOn", c), ["icloud_extension_turned_back_on"]],
  ["noteICloudExtension restored", (c) => counts.noteICloudExtension("restored", c), ["icloud_extension_restored"]],
  ["noteICloudExtension failed", (c) => counts.noteICloudExtension("failed", c), ["icloud_extension_failures"]],
  ["notePasswordManagerChosen apple", (c) => counts.notePasswordManagerChosen("apple", c), ["password_manager_chose_apple"]],
  ["noteWebKitAutofillCount autofillMeCardFill", (c) => noteWebKitAutofillCount("autofillMeCardFill", c), ["webkit_autofill_me_card_fills"]],
  ["noteMeCardFill chromium", (c) => counts.noteMeCardFill(c), ["me_card_fills_chromium"]],
  ...Object.entries(KIND_CATEGORIES).flatMap(([name, category]) =>
    Object.entries(KINDS).map(([kind, wire]) => [`noteLoginList ${name} ${kind}`, (c) => counts.noteLoginList(name, "webkit", c, kind), [LOGIN_LIST[name], `${LOGIN_LIST[name]}_webkit`, `apple_passwords_${category}_failures_${wire}`]]),
  ),
  ...Object.entries(KINDS).map(([kind, wire]) => [`noteApplePasswordsSave saveFailed ${kind}`, (c) => counts.noteApplePasswordsSave("saveFailed", "chromium", c, kind), [SAVES.saveFailed, `${SAVES.saveFailed}_chromium`, `apple_passwords_save_failures_${wire}`]]),
  ["noteLoginList filled with a kind", (c) => counts.noteLoginList("filled", "webkit", c, "refused"), [LOGIN_LIST.filled, `${LOGIN_LIST.filled}_webkit`]],
];

const take = () => ({ ...counts.takePasswordManagerCounts(), ...takeWebKitAutofillCounts() });
const nonZero = (taken) => Object.fromEntries(Object.entries(taken).filter(([, n]) => n !== 0));
const SNAPSHOT_STATE = { profiles: { a: { id: "a", passwordManager: "apple" }, b: { id: "b", passwordManager: "apple" }, c: { id: "c", passwordManager: "none" } } };
const sharing = (on) => {
  client.setSharing(on, "settings");
  take();
  return consentToken();
};

test("S10: the feature's counts are exactly the pinned list, and every other field in their modules is pinned too", () => {
  const passwordManager = Object.keys(counts.takePasswordManagerCounts());
  const webKitAutofill = Object.keys(takeWebKitAutofillCounts());
  const snapshot = Object.keys(passwordManagerProfileCounts(SNAPSHOT_STATE, []));
  const all = [...passwordManager, ...webKitAutofill, ...snapshot];
  assert.deepEqual(all.filter((field) => FEATURE.test(field)).sort(), [...Object.keys(FEATURE_COUNTS), ...Object.keys(SNAPSHOT_COUNTS)].sort(), "a count with the feature's prefixes is pinned here with its What's Sent phrase");
  assert.deepEqual(passwordManager.filter((field) => !FEATURE.test(field)).sort(), OTHER_PASSWORD_MANAGER_COUNTS, "a new field in passwordManagerCounts is classified here");
  assert.deepEqual(webKitAutofill.filter((field) => !FEATURE.test(field)).sort(), OTHER_WEBKIT_AUTOFILL_COUNTS, "a new field in webKitAutofillCounts is classified here");
  assert.deepEqual(snapshot.filter((field) => !FEATURE.test(field)).sort(), OTHER_SNAPSHOT_COUNTS, "a new field in the password manager snapshot is classified here");
  const noted = new Set(NOTES.flatMap(([, , fields]) => fields));
  assert.deepEqual(Object.keys(FEATURE_COUNTS).filter((field) => !noted.has(field)), [], "every pinned count has a note call below");
});

test("S10: with sharing off, or with a token from before sharing went off, no note records anything; with sharing on each records exactly 1 in its own fields", () => {
  const stale = sharing(true);
  assert.ok(stale);
  sharing(false);
  for (const [name, note] of NOTES) {
    note(null);
    note(stale);
    note(undefined);
    assert.deepEqual(nonZero(take()), {}, `${name} records nothing while sharing is off`);
  }
  const token = sharing(true);
  for (const [name, note, fields] of NOTES) {
    note(token);
    assert.deepEqual(nonZero(take()), Object.fromEntries(fields.map((field) => [field, 1])), `${name} records exactly its own fields`);
  }
  sharing(false);
});

const SITE = "https://bank.test/login?user=ada@example.test";
const HOSTILE_ARGS = [
  ...[SITE, "ada@example.test", "fixture-pw-ada-1", "safari", "chrome", ""].map((value) => ({ id: `text.${value}`, value })),
  ...HOSTILE_VALUES,
];

test("S10: no argument a caller or native passes (a site, a username, an unknown engine or count name) adds a field or lands in the output, and every value is a count", () => {
  const token = sharing(true);
  const shape = Object.keys(take()).sort();
  const threw = new Set();
  let id = "";
  const call = (name, note) => {
    try {
      note();
    } catch {
      threw.add(`${name} ${id}`);
    }
  };
  let value;
  for ({ id, value } of HOSTILE_ARGS) {
    call("noteLoginList", () => counts.noteLoginList(value, value, token));
    call("noteLoginList", () => counts.noteLoginList("shown", value, token));
    call("noteLoginList", () => counts.noteLoginList("fillFailed", "webkit", token, value));
    call("noteApplePasswordsSave", () => counts.noteApplePasswordsSave("saveFailed", "webkit", token, value));
    call("noteApplePasswordsSave", () => counts.noteApplePasswordsSave(value, value, token));
    call("noteApplePasswordsSave", () => counts.noteApplePasswordsSave("saveSent", value, token));
    call("noteApplePasswordsPairing", () => counts.noteApplePasswordsPairing(value, token));
    call("noteApplePasswordsPairingFailed", () => counts.noteApplePasswordsPairingFailed(value, token));
    call("noteMeCardSwitch", () => counts.noteMeCardSwitch(value, token));
    call("noteOnboardingOffer", () => counts.noteOnboardingOffer(value, value, token));
    call("noteOnboardingOffer", () => counts.noteOnboardingOffer("meCard", value, token));
    call("noteICloudExtension", () => counts.noteICloudExtension(value, token));
    call("notePasswordManagerChosen", () => counts.notePasswordManagerChosen(value, token));
    call("noteWebKitAutofillCount", () => noteWebKitAutofillCount(value, token));
  }
  const unexpected = [...threw].filter((call) => !call.endsWith(" type.nullPrototype") && !call.startsWith("noteOnboardingOffer "));
  assert.deepEqual(unexpected, [], "only a key with no prototype, which no native event can carry, or an onboarding offer the types rule out, throws; neither records anything");
  startLoginListCounts();
  const wire = (data) => JSON.parse(JSON.stringify({ ...data, epoch: client.consentEpoch() }));
  for ({ value } of HOSTILE_ARGS) {
    native.emitEvent("passwords.loginListCounted", wire({ name: value, engine: value }));
    native.emitEvent("passwords.loginListCounted", wire({ name: "filled", engine: value }));
    native.emitEvent("passwords.applePasswordsSaveCounted", wire({ name: value, engine: value }));
    native.emitEvent("passwords.loginListCounted", wire({ name: "listFailed", engine: "webkit", kind: value }));
    native.emitEvent("passwords.applePasswordsSaveCounted", wire({ name: "saveFailed", engine: "webkit", kind: value }));
  }
  native.emitEvent("passwords.loginListCounted", wire({ name: "listFailed", engine: "chromium", kind: "timedOut" }));
  native.emitEvent("passwords.loginListCounted", wire({ name: "filled", engine: "webkit" }));
  const taken = take();
  assert.deepEqual(Object.keys(taken).sort(), shape, "no field was added");
  for (const [field, n] of Object.entries(taken)) assert.ok(Number.isSafeInteger(n) && n >= 0, `${field} is a count, not ${typeof n}`);
  assert.ok(taken.apple_passwords_login_list_filled > 0 && taken.apple_passwords_login_list_shown > 0, "real names still count, so the check ran on recorded counts");
  assert.deepEqual([taken.apple_passwords_login_list_filled_chromium, taken.apple_passwords_login_list_filled_webkit], [0, 1], "only a real engine name counts by engine");
  assert.equal(taken.apple_passwords_list_failures_timed_out, 1, "only a real failure kind counts by kind");
  const sent = JSON.stringify(taken);
  for (const needle of ["bank.test", "ada@", "fixture-pw", "safari", "javascript:", "ardia-fixture", "__proto__", "[object"]) assert.ok(!sent.includes(needle), `the output has no ${needle}`);
  const snapshot = passwordManagerProfileCounts({ profiles: { [SITE]: { id: SITE, passwordManager: "apple" }, "ada@example.test": { id: "ada@example.test", passwordManager: "plugin:bitwarden" } } }, []);
  assert.equal(snapshot.password_manager_profiles_apple, "1");
  assert.ok(Object.values(snapshot).every((n) => /^[0-9]+$/.test(n)), "the snapshot holds counts only");
  assert.ok(!JSON.stringify(snapshot).includes("bank.test") && !JSON.stringify(snapshot).includes("ada@"), "the snapshot names no profile");
  sharing(false);
});

test("S10: every feature count maps to its phrase in What's Sent, in an item that says what is never sent", () => {
  const items = WHATS_SENT.flatMap((section) => section.items);
  for (const [field, phrase] of Object.entries({ ...FEATURE_COUNTS, ...SNAPSHOT_COUNTS })) {
    const item = items.find((text) => text.includes(phrase));
    assert.ok(item, `${field}: What's Sent says "${phrase}"`);
    assert.match(item, /Never /, `${field}: its What's Sent item says what is never sent`);
  }
});
