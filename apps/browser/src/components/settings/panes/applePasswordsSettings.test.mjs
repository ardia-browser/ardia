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
const { loadApplePasswords } = await import("../../../state/site/applePasswords.ts");
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
  const texts = (node) => (typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(texts) : node?.props ? texts(node.props.children) : []);
  return {
    get text() {
      return texts(sheet.value).join(" ");
    },
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
