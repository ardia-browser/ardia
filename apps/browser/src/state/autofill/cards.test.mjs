import assert from "node:assert/strict";
import { test } from "node:test";
import { cardExpiry, cardFormProblem, cardMatches, cardNumberSummary, cardsInOrder, cardTitle, expiryYears, formatCardNumber } from "./cards.ts";
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "cards-test");

const AUG_2026 = new Date(2026, 7, 15);
const card = (over) => ({ id: "c", network: "visa", last4: "1111", created: 0, modified: 0, ...over });

test("a card without an expiry says nothing about it and never counts as expired", () => {
  assert.deepEqual(cardExpiry(card({}), AUG_2026), { label: "", expired: false });
  assert.deepEqual(cardExpiry(card({ expMonth: 8 }), AUG_2026), { label: "", expired: false });
  assert.deepEqual(cardExpiry(card({ expYear: 2020 }), AUG_2026), { label: "", expired: false });
});

test("a card expires after the last day of its month, not on the first", () => {
  assert.equal(cardExpiry(card({ expMonth: 7, expYear: 2026 }), AUG_2026).expired, true);
  assert.equal(cardExpiry(card({ expMonth: 12, expYear: 2025 }), AUG_2026).expired, true);
  assert.equal(cardExpiry(card({ expMonth: 8, expYear: 2026 }), AUG_2026).expired, false);
  assert.equal(cardExpiry(card({ expMonth: 1, expYear: 2027 }), AUG_2026).expired, false);
});

test("the expiry reads as on the card", () => {
  assert.equal(cardExpiry(card({ expMonth: 3, expYear: 2029 }), AUG_2026).label, "03/29");
  assert.equal(cardExpiry(card({ expMonth: 12, expYear: 2100 }), AUG_2026).label, "12/00");
});

test("the title names the network and the last four digits only", () => {
  assert.equal(cardTitle(card({ network: "amex", last4: "0005" })), "American Express •••• 0005");
  assert.equal(cardTitle(card({ network: "card", last4: "4242" })), "Card •••• 4242");
});

test("expired cards sink below the rest, which keep their order", () => {
  const cards = [card({ id: "old", expMonth: 1, expYear: 2024 }), card({ id: "a", expMonth: 1, expYear: 2030 }), card({ id: "none" }), card({ id: "b", expMonth: 2, expYear: 2028 })];
  assert.deepEqual(cardsInOrder(cards, AUG_2026).map((c) => c.id), ["a", "none", "b", "old"]);
});

test("search finds a card by network, last digits or name, ignoring case", () => {
  const visa = card({ name: "Jordan Avery" });
  assert.equal(cardMatches(visa, ""), true);
  assert.equal(cardMatches(visa, "VISA"), true);
  assert.equal(cardMatches(visa, "1111"), true);
  assert.equal(cardMatches(visa, "jordan av"), true);
  assert.equal(cardMatches(visa, "amex"), false);
  assert.equal(cardMatches(visa, "4111"), false);
});

const summary = (over) => ({ digits: 16, network: "visa", complete: true, luhn: true, ...over });

test("a new card needs a whole, valid number before anything else", () => {
  const form = { isNew: true, number: null, month: "", year: "", now: AUG_2026 };
  assert.equal(cardFormProblem(form), "number");
  assert.equal(cardFormProblem({ ...form, number: summary({ digits: 0, complete: false, luhn: false }) }), "number");
  assert.equal(cardFormProblem({ ...form, number: summary({ digits: 15, complete: false }) }), "number");
  assert.equal(cardFormProblem({ ...form, number: summary({ complete: false, luhn: false }) }), "number");
  assert.equal(cardFormProblem({ ...form, number: summary({}) }), null);
});

test("a saved card keeps its number unless one was revealed and changed", () => {
  const form = { isNew: false, number: null, month: "8", year: "2029", now: AUG_2026 };
  assert.equal(cardFormProblem(form), null);
  assert.equal(cardFormProblem({ ...form, number: summary({ digits: 10, complete: false }) }), "number");
});

test("half an expiry date or one already past is flagged on a new card", () => {
  const form = { isNew: true, number: summary({}), month: "8", year: "", now: AUG_2026 };
  assert.equal(cardFormProblem(form), "expiry");
  assert.equal(cardFormProblem({ ...form, month: "", year: "2027" }), "expiry");
  assert.equal(cardFormProblem({ ...form, month: "7", year: "2026" }), "expiry");
  assert.equal(cardFormProblem({ ...form, month: "8", year: "2026" }), null);
  assert.equal(cardFormProblem({ ...form, month: "", year: "" }), null);
  assert.equal(cardFormProblem({ ...form, isNew: false, month: "7", year: "2026" }), null);
});

test("the year list starts this year, runs fifteen more and keeps a saved year that fell out of it", () => {
  const years = expiryYears(AUG_2026);
  assert.equal(years[0], 2026);
  assert.equal(years.at(-1), 2041);
  assert.deepEqual(expiryYears(AUG_2026, 2019).slice(0, 2), [2019, 2026]);
  assert.equal(expiryYears(AUG_2026, 2030).filter((y) => y === 2030).length, 1);
});

test("a typed card number reads like the Mac's secure field: network, length, Luhn", () => {
  assert.deepEqual(cardNumberSummary("4111 1111 1111 1111"), { digits: 16, network: "visa", complete: true, luhn: true });
  assert.deepEqual(cardNumberSummary("3782-822463-10005"), { digits: 15, network: "amex", complete: true, luhn: true });
  assert.deepEqual(cardNumberSummary("5555555555554444"), { digits: 16, network: "mastercard", complete: true, luhn: true });
  assert.deepEqual(cardNumberSummary("2223000048400011"), { digits: 16, network: "mastercard", complete: true, luhn: true });
  assert.equal(cardNumberSummary("4111111111111112").complete, false, "a failing check digit");
  assert.equal(cardNumberSummary("411111111111").complete, false, "too short for Visa");
  assert.deepEqual(cardNumberSummary(""), { digits: 0, network: "card", complete: false, luhn: false });
  assert.equal(cardNumberSummary("4".repeat(30)).digits, 19, "never more than 19 digits");
});

test("card numbers group the way the network prints them", () => {
  assert.equal(formatCardNumber("4111111111111111"), "4111 1111 1111 1111");
  assert.equal(formatCardNumber("378282246310005"), "3782 822463 10005");
  assert.equal(formatCardNumber("30569309025904"), "3056 930902 5904");
  assert.equal(formatCardNumber("41a11"), "4111");
});

test("a card number that can't be read where no reauth exists counts as a failed read, not a decline", async () => {
  await import("../../test-native/index.ts");
  const { readCardNumber } = await import("./actions.ts");
  const { takeAutofillCounts } = await import("../telemetry/autofillCounts.ts");
  takeAutofillCounts();
  assert.equal(await readCardNumber("", "missing-card"), null);
  const counts = takeAutofillCounts();
  assert.equal(counts.autofill_card_reauth_declined, 0);
  assert.equal(counts.autofill_card_number_reads_failed, 1);
});
