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
const { PopUp } = await import("../../ui/index.ts");
const { PasswordManagerRow } = await import("./PasswordManagerRow.tsx");

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

const expand = (element) => mount(() => element.type(element.props));

function managerMenu(profileId) {
  const row = mount(() => PasswordManagerRow({ profileId }));
  if (!row.value) return null;
  const [popUp] = find(expand(row.value).value, (n) => n.type === PopUp);
  return popUp.props;
}

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
