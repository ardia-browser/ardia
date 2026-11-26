import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

const native = await import("../../../test-native/index.ts");
const { PLATFORM_FEATURES } = await import("../../../lib/platformFeatures.ts");
const { useBrowser } = await import("../../../state/browser/store.ts");
const { SETTINGS, unshownSettings } = await import("../settingsIndex.ts");
const { Row } = await import("../Form.tsx");
const { PasswordsSection } = await import("./ProfilePasswords.tsx");
const { MeCardRow } = await import("./MeCardRow.tsx");

const S = () => useBrowser.getState();
const flush = () => new Promise((r) => setImmediate(r));

function elements(node, found = []) {
  if (Array.isArray(node)) node.forEach((n) => elements(n, found));
  else if (node && typeof node === "object" && "props" in node) {
    found.push(node);
    elements(node.props.children, found);
  }
  return found;
}

const named = (tree, name) => elements(tree).filter((e) => typeof e.type === "function" && e.type.name === name);
const rowOrder = (tree) => elements(tree).flatMap((e) => (e.type === Row && e.props.anchor ? [e.props.anchor] : named([e], "MeCardRow").length ? ["profiles.meCard"] : []));

async function passwordsSection() {
  S().hydrate({});
  S().createWindow({ url: "https://a.com/" });
  const section = mount(() => PasswordsSection({ profileId: S().settings.defaultProfileId }));
  await flush();
  return section;
}

const unshown = () => new Set(unshownSettings(S().settings, { top: false, syncOn: true, calendarAccess: true }).split("\n"));

test("S7: on a Mac, Use my Me card from Contacts sits right under Save and fill addresses; on Linux and Windows it isn't offered", async () => {
  PLATFORM_FEATURES.meCard = true;
  const mac = await passwordsSection();
  const order = rowOrder(mac.value);
  const addresses = order.indexOf("profiles.addresses");
  assert.ok(addresses >= 0, `rows: ${order.join(", ")}`);
  assert.equal(order[addresses + 1], "profiles.meCard");
  assert.equal(SETTINGS.find((e) => e.id === "profiles.meCard")?.title, "Use my Me card from Contacts");
  assert.ok(!unshown().has("profiles.meCard"));

  PLATFORM_FEATURES.meCard = false;
  const linux = await passwordsSection();
  assert.ok(!rowOrder(linux.value).includes("profiles.meCard"));
  assert.ok(unshown().has("profiles.meCard"), "settings search doesn't find it either");
  PLATFORM_FEATURES.meCard = true;
});

async function meCardRow() {
  const section = await passwordsSection();
  const [placed] = named(section.value, "MeCardRow");
  const row = mount(() => MeCardRow(placed.props));
  const toggle = () => elements(row.value).find((e) => typeof e.props.onChange === "function" && "value" in e.props);
  const description = () => elements(row.value).find((e) => e.type === Row).props.description ?? "";
  const turn = async (on) => {
    await toggle().props.onChange(on);
    for (let i = 0; i < 5; i++) await flush();
  };
  return { toggle, description, turn };
}

test("S8: turning it on is what asks macOS for Contacts; a denial turns it back off and says where to allow it", async () => {
  native.contacts.status = "notDetermined";
  native.contacts.answer = "denied";
  native.contacts.requests = 0;
  const row = await meCardRow();
  assert.equal(native.contacts.requests, 0, "showing Settings never asks");
  assert.equal(row.toggle().props.value, false);

  await row.turn(true);
  assert.equal(native.contacts.requests, 1);
  assert.equal(row.toggle().props.value, false, "a denial leaves the switch off");
  assert.match(row.description(), /System Settings › Privacy & Security › Contacts/);

  native.contacts.status = "notDetermined";
  native.contacts.answer = "authorized";
  await row.turn(true);
  assert.equal(native.contacts.requests, 2);
  assert.equal(row.toggle().props.value, true, "allowing it leaves the switch on");
  assert.doesNotMatch(row.description(), /System Settings/);

  await row.turn(false);
  assert.equal(row.toggle().props.value, false);
  assert.equal(native.contacts.requests, 2, "turning it off never asks");
});
