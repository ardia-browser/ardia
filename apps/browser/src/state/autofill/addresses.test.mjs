import assert from "node:assert/strict";
import { test } from "node:test";
import { addressChanged, addressDetail, addressFormOf, addressInputOf, addressMatches, addressProblem, addressTitle, regionLabels } from "./addresses.ts";

const jordan = { id: "a1", name: "Jordan Avery", street: "1 Infinite Loop", city: "Cupertino", state: "CA", postalCode: "95014", country: "US", email: "jordan@example.com", created: 0, modified: 0 };

test("an empty form can't be saved, and nothing is checked before there's something to check", () => {
  assert.equal(addressProblem(addressFormOf()), "empty");
  assert.equal(addressProblem({ ...addressFormOf(), name: "   " }), "empty");
  assert.equal(addressProblem({ ...addressFormOf(), country: "US" }), "empty");
  assert.equal(addressProblem({ ...addressFormOf(), name: "Jo" }), null);
});

test("a malformed email or phone number is flagged, a reasonable one isn't", () => {
  const base = { ...addressFormOf(), name: "Jo" };
  for (const bad of ["jo", "jo@", "@example.com", "jo@example", "jo @example.com"]) assert.equal(addressProblem({ ...base, email: bad }), "email", bad);
  for (const good of ["jo@example.com", " jo+tag@mail.example.co.uk "]) assert.equal(addressProblem({ ...base, email: good }), null, good);
  for (const bad of ["call me", "12", "+1 (408) 555-12x4"]) assert.equal(addressProblem({ ...base, phone: bad }), "phone", bad);
  for (const good of ["+1 (408) 555-1234", "030 555 0101", "+44 20 7946 0958"]) assert.equal(addressProblem({ ...base, phone: good }), null, good);
});

test("the form splits the street into two lines and joins it back, trimming every field", () => {
  const saved = { ...jordan, street: "Flat 4B\n221 Baker Street\nMarylebone" };
  const form = addressFormOf(saved);
  assert.equal(form.street1, "Flat 4B");
  assert.equal(form.street2, "221 Baker Street, Marylebone");
  const input = addressInputOf({ ...form, street1: "  Flat 4B ", street2: "", name: " Mika  " }, saved.id);
  assert.equal(input.street, "Flat 4B");
  assert.equal(input.name, "Mika");
  assert.equal(input.id, "a1");
  assert.equal(addressInputOf({ ...addressFormOf(), name: "A", country: " gb " }).country, "GB");
  assert.equal(addressInputOf({ ...addressFormOf(), name: "A", country: "Germany" }).country, "Germany");
});

test("an untouched form is not a change, a trimmed-away edit isn't either", () => {
  assert.equal(addressChanged(jordan, addressFormOf(jordan)), false);
  assert.equal(addressChanged(jordan, { ...addressFormOf(jordan), city: " Cupertino " }), false);
  assert.equal(addressChanged(jordan, { ...addressFormOf(jordan), city: "San Jose" }), true);
  assert.equal(addressChanged(undefined, addressFormOf()), false);
});

test("the title prefers a name, then an organization, then the street", () => {
  assert.equal(addressTitle(jordan), "Jordan Avery");
  assert.equal(addressTitle({ id: "x", organization: "Avery Studio", street: "Unter den Linden 77", created: 0, modified: 0 }), "Avery Studio");
  assert.equal(addressTitle({ id: "x", street: "Unter den Linden 77\nHof 2", created: 0, modified: 0 }), "Unter den Linden 77");
  assert.equal(addressTitle({ id: "x", email: "a@b.co", created: 0, modified: 0 }), "a@b.co");
  assert.equal(addressTitle({ id: "x", created: 0, modified: 0 }), "Address");
});

test("the detail line follows each country's order and never repeats the title", () => {
  assert.equal(addressDetail(jordan), "1 Infinite Loop, Cupertino, CA 95014");
  assert.equal(addressDetail({ id: "x", name: "Mika", street: "Flat 4B\n221 Baker Street", city: "London", postalCode: "NW1 6XE", country: "GB", created: 0, modified: 0 }), "Flat 4B, London NW1 6XE");
  assert.equal(addressDetail({ id: "x", street: "Unter den Linden 77", city: "Berlin", postalCode: "10117", country: "DE", created: 0, modified: 0 }), "10117 Berlin");
  assert.equal(addressDetail({ id: "x", name: "Only Name", created: 0, modified: 0 }), "");
  assert.equal(addressDetail({ id: "x", name: "Jo", email: "jo@example.com", created: 0, modified: 0 }), "jo@example.com");
});

test("region and postal labels follow the country", () => {
  assert.deepEqual(regionLabels("US"), { region: "State", postal: "ZIP Code" });
  assert.deepEqual(regionLabels("gb"), { region: "County", postal: "Postcode" });
  assert.deepEqual(regionLabels("CA"), { region: "Province", postal: "Postal Code" });
  assert.deepEqual(regionLabels("JP"), { region: "Prefecture", postal: "Postal Code" });
  assert.deepEqual(regionLabels(""), { region: "Region", postal: "Postal Code" });
});

test("search matches any part of an address, word by word", () => {
  assert.equal(addressMatches(jordan, "cuper 95014"), true);
  assert.equal(addressMatches(jordan, "jordan london"), false);
  assert.equal(addressMatches(jordan, ""), true);
});
