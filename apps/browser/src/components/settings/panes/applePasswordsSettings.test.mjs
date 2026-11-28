import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import { mount } from "../../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

const native = await import("../../../test-native/ardiacore.ts");
const { PLATFORM_FEATURES } = await import("../../../lib/platformFeatures.ts");
const { useBrowser } = await import("../../../state/browser/store.ts");
const { loadApplePasswords, useApplePasswords } = await import("../../../state/site/applePasswords.ts");
const ui = await import("../../ui/index.ts");
const form = await import("../Form.tsx");
const { useSettingsSheet } = await import("../../../state/settings/sheet.ts");
const { PasswordManagerRow } = await import("./PasswordManagerRow.tsx");
const { PopUp, Button, TextField } = ui;

const S = () => useBrowser.getState();
const flush = () => new Promise((r) => setImmediate(r));
const MAC_FEATURES = { ...PLATFORM_FEATURES };

function find(node, match, found = []) {
  if (Array.isArray(node)) node.forEach((n) => find(n, match, found));
  else if (node && typeof node === "object" && "props" in node) {
    if (match(node)) found.push(node);
    find(node.props.children, match, found);
  }
  return found;
}

const LEAVES = new Set([...Object.values(ui), ...Object.values(form)]);

function render(node) {
  if (Array.isArray(node)) return node.map(render);
  if (!node || typeof node !== "object" || !("props" in node)) return node;
  if (typeof node.type === "function" && !LEAVES.has(node.type)) return render(mount(() => node.type(node.props)).value);
  return { ...node, props: { ...node.props, children: render(node.props.children) } };
}

const rowFor = (profileId) => render(mount(() => PasswordManagerRow({ profileId })).value);

function managerMenu(profileId) {
  const [popUp] = find(rowFor(profileId), (n) => n.type === PopUp);
  return popUp?.props ?? null;
}

function statusOf(profileId) {
  const [row] = find(rowFor(profileId), (n) => n.type === form.Row && n.props.title === "Apple Passwords");
  if (!row) return null;
  const [connect] = find(row, (n) => n.type === Button && n.props.title === "Connect");
  return { text: row.props.description, connect: connect?.props.onPress ?? null };
}

function pairingSheet() {
  const element = useSettingsSheet.getState().sheet;
  if (!element) return null;
  const sheet = mount(() => element.type(element.props));
  const texts = (node) => (typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(texts) : node?.props ? [...texts(node.props.subtitle), ...texts(node.props.children)] : []);
  return {
    get text() {
      return texts(sheet.value).join(" ");
    },
    title: () => find(sheet.value, (n) => n.type === ui.DialogTitle)[0]?.props ?? null,
    type: (code) => find(sheet.value, (n) => n.type === TextField)[0].props.onChangeText(code),
    press: (title) => find(sheet.value, (n) => n.type === Button && n.props.title === title)[0].props.onPress(),
  };
}

const storedChoice = (profileId) => S().profiles[profileId].passwordManager;

async function settingsOn(state) {
  native.applePasswords.state = state;
  S().hydrate({});
  S().createWindow({ url: "https://a.test/" });
  await loadApplePasswords();
  await flush();
  return S().settings.defaultProfileId;
}

beforeEach(() => Object.assign(PLATFORM_FEATURES, MAC_FEATURES));

test("S1: on an entitled Mac the Password manager menu lists Apple Passwords", async () => {
  const profileId = await settingsOn("notConnected");
  const menu = managerMenu(profileId);
  assert.deepEqual(
    menu.options.map((o) => [o.value, o.title]),
    [
      ["ardia", "Ardia"],
      ["apple", "Apple Passwords"],
      ["none", "None (an extension handles logins)"],
    ],
  );
});

const offersApple = (menu) => !!menu?.options.some((o) => o.value === "apple");

test("S2: Apple Passwords is absent on an unentitled build, on macOS before 15.4, on Linux and on Windows", async () => {
  assert.equal(offersApple(managerMenu(await settingsOn("notEntitled"))), false, "unentitled build");
  assert.equal(offersApple(managerMenu(await settingsOn("tooOld"))), false, "macOS too old");
  const { PLATFORM_FEATURES: LINUX } = await import("../../../lib/platformFeatures.linux.ts");
  const { PLATFORM_FEATURES: WINDOWS } = await import("../../../lib/platformFeatures.win.ts");
  for (const [name, features] of [["Linux", LINUX], ["Windows", WINDOWS]]) {
    Object.assign(PLATFORM_FEATURES, features);
    assert.equal(offersApple(managerMenu(await settingsOn("notConnected"))), false, name);
  }
});

test("story 43: a profile that already chose Apple Passwords says Needs macOS 15.4 or later once macOS is too old, and keeps the choice in the menu", async () => {
  const profileId = await settingsOn("tooOld");
  S().updateProfile(profileId, { passwordManager: "apple" });
  await flush();
  assert.equal(statusOf(profileId)?.text, "Needs macOS 15.4 or later.");
  assert.equal(statusOf(profileId).connect, null, "no Connect button that can't work");
  const menu = managerMenu(profileId);
  assert.equal(menu.value, "apple");
  assert.ok(offersApple(menu), "the stored choice stays listed so the menu shows it");
});

test("S3: picking Apple Passwords asks for the Passwords app's code; the right code saves the choice and the status reads Connected", async () => {
  const profileId = await settingsOn("notConnected");
  managerMenu(profileId).onChange("apple");
  await flush();
  assert.notEqual(storedChoice(profileId), "apple", "nothing is saved before Pairing");
  const sheet = pairingSheet();
  assert.ok(sheet, "a Pairing sheet opens");
  assert.match(sheet.text, /code/i);
  sheet.type(native.applePasswords.code);
  sheet.press("Connect");
  await flush();
  assert.equal(storedChoice(profileId), "apple");
  assert.equal(useSettingsSheet.getState().sheet, null, "the sheet closes once paired");
  assert.equal(statusOf(profileId).text, "Connected");
  assert.equal(statusOf(profileId).connect, null);
});

test("S4: a wrong code shows an error, allows a retry and leaves the choice unchanged until the right code", async () => {
  const profileId = await settingsOn("notConnected");
  const before = storedChoice(profileId);
  managerMenu(profileId).onChange("apple");
  await flush();
  const sheet = pairingSheet();
  sheet.type("111111");
  sheet.press("Connect");
  await flush();
  assert.match(sheet.text, /didn't match/);
  assert.equal(storedChoice(profileId), before);
  assert.notEqual(useSettingsSheet.getState().sheet, null, "the sheet stays open for another try");
  assert.equal(statusOf(profileId), null, "the profile still isn't on Apple Passwords");
  sheet.type(native.applePasswords.code);
  sheet.press("Connect");
  await flush();
  assert.equal(storedChoice(profileId), "apple");
});

test("S5: Cancel leaves the choice unchanged, even when the right code's answer comes after it", async () => {
  const profileId = await settingsOn("notConnected");
  const before = storedChoice(profileId);
  managerMenu(profileId).onChange("apple");
  await flush();
  let release;
  native.applePasswords.hold = new Promise((r) => (release = r));
  const sheet = pairingSheet();
  sheet.type(native.applePasswords.code);
  sheet.press("Connect");
  await flush();
  sheet.press("Cancel");
  release();
  await flush();
  await flush();
  assert.equal(useSettingsSheet.getState().sheet, null);
  assert.equal(storedChoice(profileId), before);
  assert.equal(native.applePasswords.calls.at(-1), "cancelPairing", "the Passwords app is told to put its code away");
});

async function pairedProfile() {
  const profileId = await settingsOn("notConnected");
  managerMenu(profileId).onChange("apple");
  await flush();
  const sheet = pairingSheet();
  sheet.type(native.applePasswords.code);
  sheet.press("Connect");
  await flush();
  assert.equal(statusOf(profileId).text, "Connected");
  return profileId;
}

test("S6: when Pairing has ended the status reads Not connected, with a Connect button that asks for the code again", async () => {
  const profileId = await pairedProfile();
  native.applePasswords.state = "notConnected";
  native.emitEvent("passwords.applePasswordsChanged", { state: "notConnected" });
  await flush();
  const status = statusOf(profileId);
  assert.equal(status.text, "Not connected");
  assert.ok(status.connect, "a Connect button");
  status.connect();
  await flush();
  const sheet = pairingSheet();
  assert.match(sheet.text, /code/i);
  sheet.type(native.applePasswords.code);
  sheet.press("Connect");
  await flush();
  assert.equal(statusOf(profileId).text, "Connected");
  assert.equal(storedChoice(profileId), "apple");
});

test("story 3: Pairing in one profile picks Apple Passwords for every profile sharing its browser data, and Settings says so", async () => {
  await settingsOn("notConnected");
  const work = S().createProfile({ name: "Work" });
  const shared = S().createProfile({ name: "Shared", shareWith: work });
  const own = S().createProfile({ name: "Own" });
  managerMenu(work).onChange("apple");
  await flush();
  const sheet = pairingSheet();
  sheet.type(native.applePasswords.code);
  sheet.press("Connect");
  await flush();
  assert.equal(storedChoice(work), "apple");
  assert.equal(storedChoice(shared), "apple", "the profile sharing Work's data shares the choice");
  assert.notEqual(storedChoice(own), "apple", "a profile with its own data keeps its own");
  assert.equal(managerMenu(shared).value, "apple");
  assert.equal(statusOf(shared)?.text, "Connected");
  const [row] = find(rowFor(shared), (n) => n.type === form.Row && n.props.anchor === "profiles.passwordManager");
  assert.match(row.props.description, /Also applies to Work/);
});

test("story 6: a profile from before the update stays on Ardia once Apple Passwords is offered", async () => {
  native.applePasswords.calls.length = 0;
  const profileId = await settingsOn("notConnected");
  assert.equal(storedChoice(profileId), undefined, "an existing profile has no stored choice");
  const menu = managerMenu(profileId);
  assert.ok(offersApple(menu), "Apple Passwords is offered");
  assert.equal(menu.value, "ardia", "but the profile reads Ardia");
  assert.equal(statusOf(profileId), null, "and shows no Apple Passwords status");
  assert.deepEqual(native.applePasswords.calls.filter((c) => c === "pair"), [], "nothing starts Pairing by itself");
});

const { PasswordsSection, PasswordsPage } = await import("./ProfilePasswords.tsx");

function saveToggle(profileId) {
  const [row] = find(render(mount(() => PasswordsSection({ profileId })).value), (n) => n.type === form.Row && n.props.anchor === "profiles.offerToSavePasswords");
  const [toggle] = find(row, (n) => n.type === ui.Toggle);
  return { note: row.props.description, value: toggle.props.value, disabled: !!toggle.props.disabled };
}

test("story 9: with Apple Passwords picked, Save and fill passwords is off and can't be changed, and says Apple Passwords handles saving", async () => {
  const profileId = await settingsOn("connected");
  assert.equal(saveToggle(profileId).disabled, false, "on Ardia the toggle is live");
  S().updateProfile(profileId, { passwordManager: "apple" });
  await flush();
  const toggle = saveToggle(profileId);
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.value, false);
  assert.match(toggle.note, /^Apple Passwords handles saving/);
});

test("story 9: Ardia's saved-password list says its passwords aren't used while Apple Passwords is picked", async () => {
  const profileId = await settingsOn("connected");
  const texts = () => find(render(mount(() => PasswordsPage({ profileId })).value), (n) => n.type === form.SectionHeader || n.type === form.Row).map((n) => n.props.description ?? "");
  assert.ok(!texts().some((t) => /Apple Passwords/.test(t)), "no note on Ardia");
  S().updateProfile(profileId, { passwordManager: "apple" });
  await flush();
  assert.ok(texts().some((t) => /aren't used while Apple Passwords is this profile's password manager/.test(t)), texts().join(" | "));
});

function slotsOf(profileId) {
  const choice = mount(() => PasswordManagerRow({ profileId })).value;
  const root = mount(() => choice.type(choice.props)).value;
  assert.equal(root.type, form.GroupRows, "the manager's rows go into the Passwords group one by one");
  const plain = mount(() => form.GroupRows(root.props)).value;
  const slots = [mount(() => plain.type(plain.props)).value.props.children].flat();
  return slots.map((slot) => {
    const [divider, row] = [slot.props.children].flat();
    const shown = render(row);
    return { divider: !!divider && divider.type === ui.Divider, row: shown?.props.title ?? shown?.props.anchor ?? null };
  });
}

test("the Apple Passwords status row under the Password manager row has the divider every other row in the group has, and a row that isn't there leaves none", async () => {
  const profileId = await settingsOn("connected");
  S().updateProfile(profileId, { passwordManager: "apple" });
  await flush();
  assert.deepEqual(slotsOf(profileId), [
    { divider: false, row: "profiles.passwordManager" },
    { divider: true, row: "Apple Passwords" },
  ]);
  useApplePasswords.setState({ state: null });
  assert.deepEqual(slotsOf(profileId), [{ divider: false, row: "profiles.passwordManager" }], "no status yet, no divider under the menu");
  S().updateProfile(profileId, { passwordManager: "ardia" });
  await loadApplePasswords();
  await flush();
  assert.deepEqual(slotsOf(profileId), [{ divider: false, row: "profiles.passwordManager" }]);
});

test("the Pairing sheet's line under its title is the title's subtitle, spaced like every other sheet's", async () => {
  const profileId = await settingsOn("notConnected");
  managerMenu(profileId).onChange("apple");
  await flush();
  const title = pairingSheet().title();
  assert.equal(title.children, "Connect Apple Passwords");
  assert.equal(title.subtitle, "Enter the six-digit code the Passwords app shows.");
});
