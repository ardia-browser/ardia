import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startPlugins } = await import("../plugins/start.ts");
const lifecycle = await import("../plugins/lifecycle.ts");
const { usePlugins } = await import("../plugins/store.ts");
const { consentToken } = await import("../telemetry/consentPeriod.ts");
const { consentLines } = await import("../plugins/consent.ts");
const { patchPage, pageOf } = await import("../tabs/pageState.ts");
const { leftPage } = await import("../tabs/pageEvents.ts");
const { requestAutofill } = await import("./autofill.ts");
const { markTabReady } = await import("../tabs/pageState.ts");
const { acceptVerificationCode, declineVerificationCode, verificationCodeDocument } = await import("./verificationCodes.ts");
const pm = await import("./passwordManager.ts");

const MANIFEST = readFileSync(new URL("../../../../../tests/fixtures/plugins/password-manager/plugin.json", import.meta.url), "utf8");
const native = stub.passwordProviders;
const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const calls = (kind) => native.calls.filter((c) => c[0] === kind).map((c) => c.slice(1));

async function folders(list) {
  stub.pluginHost.folders = list;
  await lifecycle.rescanPlugins(consentToken());
  await settle();
}

const pluginFolder = (name, { bundled = false, text = MANIFEST } = {}) => ({ name, status: "ok", text: text.replace('"password-manager"', JSON.stringify(name)), ...(bundled ? { bundled: true } : {}) });

function turnOn(name) {
  assert.ok(lifecycle.requestPluginConsent(name), `consent for ${name}`);
  assert.ok(lifecycle.enablePlugin(name, P().consent.hash), `turn on ${name}`);
}

let work = "";
let shared = "";

test("before any password manager plugin is on, every profile keeps Ardia's manager and nothing is pushed for it", async () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  work = S().createProfile({ name: "Work" });
  shared = S().createProfile({ name: "Shared", shareWith: work });
  S().createWindow({ url: "https://a.example/", profileId: "default" });
  startPlugins();
  await folders([pluginFolder("system-passwords", { bundled: true }), pluginFolder("other-passwords")]);
  pm.startPasswordManager();
  await settle();
  assert.equal(pm.currentPasswordManager("default"), "ardia");
  assert.deepEqual(calls("setFieldProviders"), [[1, []]], "launch pushes the empty set once");
  assert.deepEqual(calls("offerToSave"), []);
  native.calls.length = 0;
});

test("the consent sheet names the reach and, for a built-in plugin, how many profiles move", () => {
  const m = P().listings["system-passwords"].manifest;
  const lines = consentLines(m, { bundled: true, movesProfiles: pm.neverChosenCount() }).map((l) => l.text);
  assert.ok(lines.includes("Moves 3 profiles that never picked a password manager to Test Passwords"), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith("Shows a key in login and verification code fields on every site")));
  assert.ok(lines.some((l) => l.startsWith("Offers to set up two-factor codes")));
  assert.ok(lines.some((l) => l.startsWith("Shows whether Ardia may use passkeys")));
  const installed = consentLines(P().listings["other-passwords"].manifest, { bundled: false, movesProfiles: 3 }).map((l) => l.text);
  assert.ok(!installed.some((l) => l.startsWith("Moves")), "an installed plugin moves nobody");
});

test("an installed plugin moves no profile on Turn On; a profile picks it explicitly", async () => {
  turnOn("other-passwords");
  await settle();
  assert.equal(pm.currentPasswordManager("default"), "ardia");
  assert.deepEqual(calls("setFieldProviders"), [], "nothing to push yet");
  pm.choosePasswordManager(work, "plugin:other-passwords");
  await settle();
  assert.equal(S().profiles[shared].passwordManager, "plugin:other-passwords", "profiles sharing data share the choice");
  assert.deepEqual(calls("setFieldProviders").at(-1)[1], [work]);
  assert.deepEqual(calls("offerToSave"), [[work, false]], "Work stops offering to save");
  assert.match(stub.docs.get("password-manager.json") ?? "", new RegExp(`"offerToSaveHeldOff":\\["${work}"\\]`), "the record is written before the pref flips");
  native.calls.length = 0;
});

test("turning on a built-in plugin moves only profiles that never chose; explicit choices stay", async () => {
  turnOn("system-passwords");
  await settle();
  assert.equal(S().profiles.default.passwordManager, "plugin:system-passwords", "Personal never chose, so it moves and that is recorded");
  assert.equal(S().profiles[work].passwordManager, "plugin:other-passwords", "Work's choice stays");
  assert.deepEqual(calls("setFieldProviders").at(-1)[1], ["", work].sort());
  assert.deepEqual(calls("offerToSave"), [["", false]]);
  const gens = calls("setFieldProviders").map((c) => c[0]);
  assert.ok(gens.every((g, i) => i === 0 || g > gens[i - 1]), "each push has a newer generation");
  native.calls.length = 0;
});

test("a new profile follows the built-in plugin while it's on", () => {
  const later = S().createProfile({ name: "Later" });
  assert.equal(pm.currentPasswordManager(later), "plugin:system-passwords");
  S().deleteProfile(later);
});

test("Edit › AutoFill › Passwords… opens the system panel in a profile whose manager fills with it", async () => {
  const windowId = S().windowOrder[0];
  const tabId = S().windows[windowId].tabIds[0];
  markTabReady(tabId);
  await requestAutofill(windowId, "passwords", tabId);
  assert.deepEqual(calls("showSystemPanel"), [[tabId]]);
  assert.equal(native.lastPanelGeneration, pm.providerGeneration(), "the menu request carries the current generation");
  pm.choosePasswordManager("default", "ardia");
  await settle();
  native.calls.length = 0;
  await requestAutofill(windowId, "passwords", tabId);
  assert.deepEqual(calls("showSystemPanel"), [], "an Ardia profile gets Chrome's dropdown as before");
  pm.choosePasswordManager("default", "plugin:system-passwords");
  await settle();
  native.calls.length = 0;
});

test("Edit › AutoFill › Passwords… opens Passwords settings only when the panel can't have opened, never after macOS took the request", async () => {
  const windowId = S().windowOrder[0];
  const tabId = S().windows[windowId].tabIds[0];
  markTabReady(tabId);
  const settingsOpened = async (panel) => {
    native.panel = panel;
    stub.windows.open.clear();
    await requestAutofill(windowId, "passwords", tabId);
    return [...stub.windows.open.keys()].some((id) => /settings/i.test(id));
  };
  try {
    assert.equal(await settingsOpened({ shown: false, reason: "noPanel" }), false, "macOS took the request; the panel may be up");
    assert.equal(await settingsOpened({ shown: false, reason: "tabGone" }), false, "the tab went away mid-request");
    assert.equal(await settingsOpened({ shown: true }), false);
    assert.equal(await settingsOpened({ shown: false, reason: "notFocused" }), true, "no login field, so Settings explains where passwords live");
  } finally {
    native.panel = { shown: true };
    native.calls.length = 0;
  }
});

test("a verification code found in a profile that sets them up is offered, accepted with its token, and closed by navigation or a new provider set", async () => {
  const windowId = S().windowOrder[0];
  const tabId = S().windows[windowId].tabIds[0];
  pm.verificationCodeFound(tabId, { token: "t1", main: true, app: "Passwords" });
  await settle();
  assert.deepEqual(pageOf(tabId).verificationCode, { token: "t1", app: "Passwords", host: "a.example", generation: pm.providerGeneration() });
  acceptVerificationCode(tabId);
  await settle();
  assert.deepEqual(native.opened.at(-1), { tab: tabId, token: "t1", generation: pm.providerGeneration() }, "the token is redeemed with the generation it was offered in");
  assert.equal(pageOf(tabId).verificationCode, null);

  pm.verificationCodeFound(tabId, { token: "t2", main: true, app: "Passwords" });
  await settle();
  leftPage(tabId, "https://b.example/", "https://a.example/", "chromium", false);
  assert.equal(pageOf(tabId).verificationCode, null, "navigation closes it");

  patchPage(tabId, { verificationCode: { token: "t3", app: "Passwords", host: "a.example", generation: 1 } });
  pm.choosePasswordManager(work, "ardia");
  await settle();
  assert.equal(pageOf(tabId).verificationCode, null, "a changed provider set closes it");
  pm.choosePasswordManager(work, "plugin:other-passwords");
  await settle();

  pm.verificationCodeFound(tabId, { token: "t4", main: true });
  await settle();
  assert.equal(pageOf(tabId).verificationCode, null, "a token with no app bound to it is never offered");
  native.calls.length = 0;
});

test("a second code on the same page waits for the first prompt to close, and a reload of the same URL closes both", async () => {
  const windowId = S().windowOrder[0];
  const tabId = S().windows[windowId].tabIds[0];
  verificationCodeDocument(tabId, 1000);
  pm.verificationCodeFound(tabId, { token: "q1", main: true, app: "Passwords" });
  pm.verificationCodeFound(tabId, { token: "q2", main: true, app: "Passwords" });
  assert.equal(pageOf(tabId).verificationCode?.token, "q1");
  declineVerificationCode(tabId);
  assert.equal(pageOf(tabId).verificationCode?.token, "q2", "the second code is offered next");
  pm.verificationCodeFound(tabId, { token: "q3", main: true, app: "Passwords" });
  verificationCodeDocument(tabId, 1000);
  assert.equal(pageOf(tabId).verificationCode?.token, "q2", "the same document keeps its prompt");
  verificationCodeDocument(tabId, 2000);
  assert.equal(pageOf(tabId).verificationCode, null, "a new document (a reload) closes it");
  declineVerificationCode(tabId);
  assert.equal(pageOf(tabId).verificationCode, null, "and drops the queued one with it");
  pm.verificationCodeFound(tabId, { token: "q4", main: true, app: "Passwords" });
  assert.equal(pageOf(tabId).verificationCode?.token, "q4", "the new document's code is offered");
  declineVerificationCode(tabId);
});

test("turning a plugin off withdraws its profiles natively before the host reports it off, and gives offer to save back", async () => {
  let seenAtCommit = null;
  const unsubscribe = usePlugins.subscribe((s, prev) => {
    if (seenAtCommit === null && prev.records["system-passwords"]?.enabled && !s.records["system-passwords"]?.enabled) seenAtCommit = native.profiles.map((p) => p.profile);
  });
  assert.ok(await lifecycle.turnOffPlugin("system-passwords", consentToken()));
  unsubscribe();
  assert.deepEqual(seenAtCommit, [work], "Personal was gone natively before the store said the plugin is off");
  await settle();
  assert.equal(pm.currentPasswordManager("default"), "ardia");
  assert.equal(S().profiles.default.passwordManager, "plugin:system-passwords", "the stored choice stays for when it comes back");
  assert.deepEqual(calls("offerToSave"), [["", true]]);
  assert.doesNotMatch(stub.docs.get("password-manager.json") ?? "", /""/, "the record is cleared before the pref flips back");
  native.calls.length = 0;
  turnOn("system-passwords");
  await settle();
  assert.equal(pm.currentPasswordManager("default"), "plugin:system-passwords", "turning it back on restores the choice");
  native.calls.length = 0;
});

test("a changed manifest withdraws the plugin until it's approved again", async () => {
  await folders([pluginFolder("system-passwords", { bundled: true, text: MANIFEST.replace('"1.0.0"', '"1.0.1"') }), pluginFolder("other-passwords")]);
  assert.equal(pm.currentPasswordManager("default"), "ardia");
  assert.deepEqual(native.profiles.map((p) => p.profile), [work]);
});

test("a choice counts only for the plugin approved under that name", async () => {
  await folders([pluginFolder("system-passwords", { bundled: true })]);
  assert.equal(pm.currentPasswordManager(work), "ardia", "other-passwords is gone, so Work reads as Ardia");
  await folders([pluginFolder("system-passwords", { bundled: true }), pluginFolder("other-passwords", { text: MANIFEST.replace("Test Passwords", "Someone Else") })]);
  assert.equal(pm.currentPasswordManager(work), "ardia", "a different manifest under the same name isn't the approved one");
  lifecycle.disablePlugin("system-passwords", consentToken());
  lifecycle.disablePlugin("other-passwords", consentToken());
});

test("a panel seen beside the field gets Ardia's hint on the other side, named for the site, until the profile closes it three times", async () => {
  const hints = await import("./panelHints.ts");
  const counts = await import("../telemetry/passwordManagerCounts.ts");
  hints.forgetPanelHintsForTests();
  stub.docs.delete(hints.PANEL_HINTS_DOCUMENT);
  counts.takePasswordManagerCounts();
  const windowId = S().windowOrder[0];
  const tabId = S().windows[windowId].tabIds[0];
  const label = hints.panelHintLabel(S().tabs[tabId].url);
  assert.ok(label, "the test tab has a site label");
  native.hints.length = 0;
  pm.fieldProviderOpened(tabId, { via: "badge", shown: true, panel: "below" });
  pm.fieldProviderOpened(tabId, { via: "menu", shown: true, panel: "above" });
  pm.fieldProviderOpened(tabId, { via: "badge", shown: true });
  pm.fieldProviderOpened(tabId, { via: "badge", shown: false, reason: "noPanel" });
  await settle();
  assert.deepEqual(native.hints, [
    { tab: tabId, label, side: "above" },
    { tab: tabId, label, side: "below" },
  ]);
  pm.fieldProviderHint(tabId, { state: "shown" });
  for (let i = 0; i < 3; i++) pm.fieldProviderHint(tabId, { state: "dismissed" });
  assert.deepEqual(JSON.parse(stub.docs.get(hints.PANEL_HINTS_DOCUMENT)).dismissals, { [S().tabs[tabId].profileId]: 3 });
  native.hints.length = 0;
  pm.fieldProviderOpened(tabId, { via: "badge", shown: true, panel: "below" });
  await settle();
  assert.deepEqual(native.hints, [], "three closes quiet it in this profile");
  hints.forgetPanelHintsForTests();
  pm.fieldProviderOpened(tabId, { via: "badge", shown: true, panel: "below" });
  await settle();
  assert.deepEqual(native.hints, [], "and it stays quiet after a relaunch");
  const taken = counts.takePasswordManagerCounts();
  assert.equal(taken.password_manager_panel_hints_shown, 1);
  assert.equal(taken.password_manager_panel_hints_dismissed, 3);
  stub.docs.delete(hints.PANEL_HINTS_DOCUMENT);
  hints.forgetPanelHintsForTests();
});

test("the hint names one domain label, and nothing for addresses or pages that aren't web pages", async () => {
  const { panelHintLabel } = await import("./panelHints.ts");
  assert.equal(panelHintLabel("https://github.com/login"), "github");
  assert.equal(panelHintLabel("https://www.amazon.co.uk/ap/signin"), "amazon");
  assert.equal(panelHintLabel("https://accounts.google.com/"), "google");
  assert.equal(panelHintLabel("http://192.168.1.1/login"), null);
  assert.equal(panelHintLabel("file:///Users/me/login.html"), null);
  assert.equal(panelHintLabel(undefined), null);
});
