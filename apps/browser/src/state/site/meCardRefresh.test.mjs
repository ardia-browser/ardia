import assert from "node:assert/strict";
import { test } from "node:test";

const native = await import("../../test-native/index.ts");
const { setMeCardFor, startMeCard, useMeCard } = await import("./meCard.ts");

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const ADA = { name: "Ada Lovelace", organization: "", emails: ["ada@example.com"], phones: ["+44 20 7946 0000"], addresses: [{ street: "12 St James's Square", city: "London", state: "", postalCode: "SW1Y 4JH", country: "GB" }] };
const meCardSaves = () => native.savedDocNames.filter((name) => name === "me-card.json").length;
const stored = (profile) => [...(native.addressStores.get(profile)?.values() ?? [])];

test("the Contacts change listener is held only while some profile uses the Me card", async () => {
  native.contacts.status = "authorized";
  native.contacts.card = ADA;
  startMeCard();
  await settle();
  assert.equal(native.contacts.listeners(), 0, "no profile uses the Me card, so nothing listens to Contacts");

  await setMeCardFor("work", true);
  assert.equal(native.contacts.listeners(), 1, "turning one profile on starts listening");
  await setMeCardFor("home", true);
  assert.equal(native.contacts.listeners(), 1, "a second profile shares the one listener");
  await setMeCardFor("work", false);
  assert.equal(native.contacts.listeners(), 1, "one profile still uses it");
  await setMeCardFor("home", false);
  assert.equal(native.contacts.listeners(), 0, "the last profile off stops listening");
});

test("a Contacts change that leaves the Me card as it was writes nothing; one that changes it updates the same entries", async () => {
  native.contacts.status = "authorized";
  native.contacts.card = ADA;
  await setMeCardFor("p", true);
  const ids = [...useMeCard.getState().entries.p];
  assert.equal(ids.length, 1);

  native.contacts.changed();
  await settle();
  native.addressSaves.made = 0;
  const savesBefore = meCardSaves();
  native.contacts.changed();
  await settle();
  assert.equal(native.addressSaves.made, 0, "no address is rewritten for an unchanged card");
  assert.equal(meCardSaves(), savesBefore, "me-card.json isn't saved again");

  native.contacts.card = { ...ADA, phones: ["+44 20 7946 0001"] };
  native.contacts.changed();
  await settle();
  assert.equal(native.addressSaves.made, 1, "a changed card is written");
  assert.deepEqual(stored("p").map((a) => [a.id, a.phone]), [[ids[0], "+44 20 7946 0001"]], "the same entry now holds the new phone");
  assert.deepEqual(useMeCard.getState().entries.p, ids);
  assert.equal(meCardSaves(), savesBefore, "the ids didn't change, so me-card.json isn't saved");

  native.contacts.card = { ...ADA, addresses: [...ADA.addresses, { street: "1 Work Lane", city: "London", state: "", postalCode: "EC1A 1BB", country: "GB" }] };
  native.contacts.changed();
  await settle();
  assert.equal(useMeCard.getState().entries.p.length, 2, "a new address on the card adds an entry");
  assert.equal(meCardSaves(), savesBefore + 1, "and the new id is recorded");
  await setMeCardFor("p", false);
  assert.deepEqual(stored("p"), []);
});

test("a burst of Contacts changes reads the Me card at most twice", async () => {
  native.contacts.status = "authorized";
  native.contacts.card = ADA;
  await setMeCardFor("q", true);
  native.contacts.reads = 0;
  for (let i = 0; i < 5; i++) native.contacts.changed();
  await settle();
  assert.ok(native.contacts.reads <= 2, `read ${native.contacts.reads} times`);
  assert.ok(native.contacts.reads >= 1, "the change is still read");
  await setMeCardFor("q", false);
  native.contacts.card = null;
});

test("a Me card Ardia isn't allowed to read keeps the saved entries and says why", async () => {
  native.contacts.status = "authorized";
  native.contacts.card = ADA;
  await setMeCardFor("denied", true);
  const ids = [...useMeCard.getState().entries.denied];
  assert.equal(stored("denied").length, 1);

  native.contacts.status = "denied";
  native.contacts.changed();
  await settle();
  assert.deepEqual(useMeCard.getState().entries.denied, ids, "the switch keeps its entries");
  assert.equal(stored("denied").length, 1, "the saved entry still fills");
  assert.match(useMeCard.getState().hints.denied ?? "", /isn't allowed to read your contacts/, "Settings says why the card isn't updating");

  native.contacts.status = "authorized";
  native.contacts.card = { ...ADA, phones: ["+44 20 7946 0002"] };
  native.contacts.changed();
  await settle();
  assert.equal(useMeCard.getState().hints.denied ?? null, null, "access back clears the hint");
  assert.deepEqual(stored("denied").map((a) => a.phone), ["+44 20 7946 0002"], "and the card is read again");
  await setMeCardFor("denied", false);
});

test("a Me card refresh before Contacts access was decided keeps the entries, asks nothing and says how to allow it", async () => {
  native.contacts.status = "authorized";
  native.contacts.card = ADA;
  await setMeCardFor("fresh", true);
  native.contacts.status = "notDetermined";
  native.contacts.requests = 0;
  native.contacts.changed();
  await settle();
  assert.equal(native.contacts.requests, 0, "only the switch or onboarding asks for Contacts");
  assert.equal(stored("fresh").length, 1, "the saved entry still fills");
  assert.match(useMeCard.getState().hints.fresh ?? "", /Turn this switch off and on/);
  native.contacts.status = "authorized";
  await setMeCardFor("fresh", false);
});

test("a Me card read that fails keeps the saved entries", async () => {
  native.contacts.status = "authorized";
  native.contacts.card = ADA;
  await setMeCardFor("flaky", true);
  const ids = [...useMeCard.getState().entries.flaky];
  native.contacts.readError = "the Contacts store isn't ready";
  native.contacts.card = { ...ADA, phones: ["+44 20 7946 0003"] };
  native.contacts.changed();
  await settle();
  native.contacts.readError = null;
  assert.deepEqual(useMeCard.getState().entries.flaky, ids);
  assert.equal(stored("flaky").length, 1, "nothing was deleted");
  native.contacts.changed();
  await settle();
  assert.deepEqual(stored("flaky").map((a) => a.phone), ["+44 20 7946 0003"], "the next change reads it");
  await setMeCardFor("flaky", false);
  native.contacts.card = null;
});
