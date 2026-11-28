import assert from "node:assert/strict";
import { after, test } from "node:test";
import { nativeEvents } from "../../test-native/events.ts";

const native = await import("../../test-native/index.ts");
const webKit = nativeEvents();
globalThis.acTestNativeModules = {
  ...globalThis.acTestNativeModules,
  ArdiaWebKit: { call: () => Promise.resolve("null"), addListener: webKit.addListener },
};
globalThis.fetch = async () => ({ status: 503 });

const client = await import("../telemetry/client.ts");
const { takePasswordManagerCounts } = await import("../telemetry/passwordManagerCounts.ts");
const { takeWebKitAutofillCounts } = await import("../telemetry/webKitAutofillCounts.ts");
const { setMeCardFor, startMeCard, useMeCard } = await import("./meCard.ts");
after(() => client.setSharing(false, "settings"));

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const filled = (entry) => webKit.emit("webKit", { name: "webKit.counted", data: { name: "autofillAddressFill", entry, epoch: client.consentEpoch() } });

test("turning the Me card on and macOS refusing it are counted, and a WebKit fill from a Me card entry counts as a Me card fill", async () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  takePasswordManagerCounts();
  takeWebKitAutofillCounts();

  native.contacts.status = "notDetermined";
  native.contacts.answer = "denied";
  await setMeCardFor("", true);
  native.contacts.status = "authorized";
  native.contacts.card = { name: "Ada Lovelace", organization: "", emails: ["ada@example.com"], phones: [], addresses: [] };
  await setMeCardFor("", true);
  await flush();
  const switched = takePasswordManagerCounts();
  assert.equal(switched.me_card_turned_on, 1);
  assert.equal(switched.me_card_access_refused, 1);

  startMeCard();
  const [entry] = useMeCard.getState().entries[""];
  assert.ok(entry);
  filled(entry);
  filled("an-address-saved-in-ardia");
  const fills = takeWebKitAutofillCounts();
  assert.equal(fills.webkit_autofill_me_card_fills, 1);
  await setMeCardFor("", false);
});

test("story 63: a Chromium tab's fill from a Me card entry counts as a Me card fill there, and an address saved in Ardia doesn't", async () => {
  client.setSharing(true, "settings");
  native.contacts.status = "authorized";
  native.contacts.card = { name: "Ada Lovelace", organization: "", emails: ["ada@example.com"], phones: [], addresses: [] };
  await setMeCardFor("", true);
  await flush();
  startMeCard();
  takePasswordManagerCounts();
  const [entry] = useMeCard.getState().entries[""];
  native.emitEvent("autofill.addressFilled", { entry, epoch: client.consentEpoch() });
  native.emitEvent("autofill.addressFilled", { entry: "an-address-saved-in-ardia", epoch: client.consentEpoch() });
  assert.equal(takePasswordManagerCounts().me_card_fills_chromium, 1);
  await setMeCardFor("", false);
  native.contacts.card = null;
});
