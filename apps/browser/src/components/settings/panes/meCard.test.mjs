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
const { AddressesPage } = await import("./ProfileAutofill.tsx");
const { Button, TextField } = await import("../../ui/index.ts");
const { useSettingsSheet } = await import("../../../state/settings/sheet.ts");
const { currentEngineProfile } = await import("../../../state/browser/current.ts");

const S = () => useBrowser.getState();
const flush = () => new Promise((r) => setImmediate(r));

function elements(node, found = []) {
  if (Array.isArray(node)) node.forEach((n) => elements(n, found));
  else if (node && typeof node === "object" && "props" in node) {
    found.push(node);
    for (const value of Object.values(node.props ?? {})) elements(value, found);
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

const ADA = {
  name: "Ada Lovelace",
  organization: "Analytical Engines",
  emails: ["ada@example.com"],
  phones: ["+44 20 7946 0000"],
  addresses: [{ street: "12 St James's Square", city: "London", state: "", postalCode: "SW1Y 4JH", country: "GB" }],
};

test("S9: entries from Contacts are listed as From Contacts and open read-only with Edit in Contacts", async () => {
  native.contacts.status = "authorized";
  native.contacts.card = ADA;
  native.contacts.opened = 0;
  const row = await meCardRow();
  const profile = currentEngineProfile(S().settings.defaultProfileId);
  native.addressStores.set(profile, new Map([["mine", { id: "mine", name: "Ada at home", street: "1 Home Road", city: "Bath", created: 0, modified: 0 }]]));
  await row.turn(true);

  const page = mount(() => AddressesPage({ profileId: S().settings.defaultProfileId }));
  for (let i = 0; i < 5; i++) await flush();
  const rows = elements(page.value).filter((e) => e.type === Row && e.props.onPress);
  const fromContacts = rows.filter((r) => /From Contacts/.test(String(r.props.description)));
  assert.deepEqual(fromContacts.map((r) => r.props.title), ["Ada Lovelace"]);
  const own = rows.find((r) => r.props.title === "Ada at home");
  assert.ok(own, `rows: ${rows.map((r) => r.props.title).join(", ")}`);
  assert.doesNotMatch(String(own.props.description), /From Contacts/);

  fromContacts[0].props.onPress();
  const sheet = useSettingsSheet.getState().sheet;
  const opened = mount(() => sheet.type(sheet.props));
  const buttons = elements(opened.value).filter((e) => e.type === Button).map((b) => b.props.title);
  assert.ok(buttons.includes("Edit in Contacts"), `buttons: ${buttons.join(", ")}`);
  assert.ok(!buttons.includes("Delete") && !buttons.includes("Save"), `buttons: ${buttons.join(", ")}`);
  assert.equal(elements(opened.value).filter((e) => e.type === TextField).length, 0, "nothing to type into");
  assert.ok(elements(opened.value).some((e) => e.type === Row && e.props.description === "SW1Y 4JH"), "the card's values show as text");
  elements(opened.value).find((e) => e.type === Button && e.props.title === "Edit in Contacts").props.onPress();
  await flush();
  assert.equal(native.contacts.opened, 1);

  own.props.onPress();
  const editor = useSettingsSheet.getState().sheet;
  assert.ok(elements(mount(() => editor.type(editor.props)).value).some((e) => e.type === TextField), "an address saved in Ardia still opens the editor");
  await row.turn(false);
});

test("S9: a save that fails part way through the Me card's addresses leaves no entry unrecorded, so a refresh makes no duplicates", async () => {
  const { setMeCardFor, useMeCard } = await import("../../../state/site/meCard.ts");
  S().hydrate({});
  const profile = currentEngineProfile(S().settings.defaultProfileId);
  native.addressStores.delete(profile);
  native.contacts.status = "authorized";
  native.contacts.card = { ...ADA, addresses: [ADA.addresses[0], { street: "1 Work Lane", city: "London", state: "", postalCode: "EC1A 1BB", country: "GB" }] };
  native.addressSaves.made = 0;
  native.addressSaves.failOn = 2;
  await assert.rejects(setMeCardFor(profile, true), /refused the save/);
  native.addressSaves.failOn = null;
  const stored = () => [...(native.addressStores.get(profile)?.keys() ?? [])].sort();
  assert.equal(stored().length, 1, "the first address was saved before the second failed");
  assert.deepEqual([...(useMeCard.getState().entries[profile] ?? [])].sort(), stored(), "the saved address is recorded as from Contacts");
  await setMeCardFor(profile, true);
  assert.equal(stored().length, 2, "a refresh writes the card's two addresses, no duplicate");
  assert.deepEqual([...useMeCard.getState().entries[profile]].sort(), stored());
  await setMeCardFor(profile, false);
  assert.deepEqual(stored(), [], "turning it off removes them all");
  native.contacts.card = null;
});

test("story 56: each Me card entry carries the card's first email and first phone, in the order set in Contacts", async () => {
  const { meCardEntries } = await import("../../../state/site/meCard.ts");
  const HOME = { street: "1 Home Road", city: "Bath", state: "", postalCode: "BA1 1AA", country: "GB" };
  const WORK = { street: "12 St James's Square", city: "London", state: "", postalCode: "SW1Y 4JH", country: "GB" };
  const card = { name: "Ada Lovelace", organization: "", emails: ["ada.work@example.com", "ada@example.com"], phones: ["+44 20 7946 0177", "+44 20 7946 0000"], addresses: [HOME, WORK] };
  assert.deepEqual(
    meCardEntries(card).map((e) => [e.street, e.email, e.phone]),
    [
      ["1 Home Road", "ada.work@example.com", "+44 20 7946 0177"],
      ["12 St James's Square", "ada.work@example.com", "+44 20 7946 0177"],
    ],
  );
});
