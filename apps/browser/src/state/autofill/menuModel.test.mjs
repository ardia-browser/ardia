import assert from "node:assert/strict";
import { test } from "node:test";
import { autofillMenuRows, autofillRestingRow, isTouchCardRow } from "./menuModel.ts";

const NOW = new Date(2026, 7, 15);
const jordan = { id: "a1", name: "Jordan Avery", street: "1 Infinite Loop", city: "Cupertino", state: "CA", postalCode: "95014", country: "US", email: "jordan@example.com", created: 0, modified: 0 };
const studio = { id: "a2", organization: "Avery Studio", street: "Unter den Linden 77", city: "Berlin", postalCode: "10117", country: "DE", phone: "+49305550101", created: 0, modified: 0 };
const visa = { id: "c1", network: "visa", last4: "1111", name: "Jordan Avery", expMonth: 8, expYear: 2029, created: 0, modified: 0 };
const old = { id: "c2", network: "mastercard", last4: "4444", expMonth: 3, expYear: 2024, created: 0, modified: 0 };
const input = (over) => ({ kind: "address", part: "name", addresses: [jordan, studio], cards: [visa, old], enabled: { addresses: true, cards: true }, now: NOW, ...over });

test("a kind turned off in Settings offers nothing, not even the footer", () => {
  assert.deepEqual(autofillMenuRows(input({ enabled: { addresses: false, cards: true } })), []);
  assert.deepEqual(autofillMenuRows(input({ kind: "card", part: "number", enabled: { addresses: true, cards: false } })), []);
});

test("nothing saved offers nothing, so Chrome's own list stays", () => {
  assert.deepEqual(autofillMenuRows(input({ addresses: [] })), []);
  assert.deepEqual(autofillMenuRows(input({ kind: "card", part: "number", cards: [] })), []);
});

test("an address without the focused field's value isn't offered for it", () => {
  const rows = autofillMenuRows(input({ part: "email" }));
  assert.deepEqual(rows.map((r) => r.key), ["address:a1", "manage:address"]);
  assert.equal(rows[0].title, "jordan@example.com");
  assert.equal(rows[0].detail, "Jordan Avery");
});

test("when no address has the focused value the menu still offers nothing to fill", () => {
  assert.deepEqual(autofillMenuRows(input({ part: "cvc", kind: "address" })), []);
  assert.deepEqual(autofillMenuRows(input({ addresses: [studio], part: "email" })), []);
});

test("an address row shows the focused value first and a short summary under it", () => {
  const rows = autofillMenuRows(input({ part: "street" }));
  assert.equal(rows[0].title, "1 Infinite Loop");
  assert.equal(rows[0].detail, "Jordan Avery, Cupertino");
  assert.equal(rows[1].title, "Unter den Linden 77");
  assert.equal(rows[1].detail, "Avery Studio, Berlin");
  assert.equal(rows.at(-1).kind, "manage");
});

test("two addresses that would read the same appear once", () => {
  const twin = { ...jordan, id: "a3", phone: "+14085550000" };
  const rows = autofillMenuRows(input({ addresses: [jordan, twin], part: "name" }));
  assert.equal(rows.filter((r) => r.kind === "address").length, 2);
  const same = { ...jordan, id: "a4" };
  assert.equal(autofillMenuRows(input({ addresses: [jordan, same], part: "name" })).filter((r) => r.kind === "address").length, 1);
});

test("cards list every saved card, expired ones last and marked, for any card field", () => {
  for (const part of ["number", "name", "expiry", "cvc"]) {
    const rows = autofillMenuRows(input({ kind: "card", part }));
    assert.deepEqual(rows.map((r) => r.key), ["card:c1", "card:c2", "manage:card"], part);
    assert.equal(rows[0].title, "Visa •••• 1111");
    assert.equal(rows[0].detail, "Jordan Avery · 08/29");
    assert.equal(rows[1].expired, true);
    assert.equal(rows[1].detail, "Expired 03/24");
  }
});

test("the menu rests on the first live entry, never on an expired card or the footer", () => {
  assert.equal(autofillRestingRow(autofillMenuRows(input({}))), 0);
  assert.equal(autofillRestingRow(autofillMenuRows(input({ kind: "card", part: "number", cards: [old] }))), -1);
  assert.equal(autofillRestingRow([]), -1);
});

test("only card rows carry Touch ID", () => {
  const rows = autofillMenuRows(input({ kind: "card", part: "number" }));
  assert.equal(isTouchCardRow(rows[0]), true);
  assert.equal(isTouchCardRow(rows.at(-1)), false);
  assert.equal(isTouchCardRow(autofillMenuRows(input({}))[0]), false);
  assert.equal(isTouchCardRow(undefined), false);
});
