import assert from "node:assert/strict";
import test from "node:test";
import { withAlpha } from "./color.ts";
import { inlineOffer } from "./inlineOffer.ts";

test("the field is offered the text the omnibox answered for, with its completion after it, as main's SearchSuggestionsModel.completion", () => {
  assert.deepEqual(inlineOffer("gle.com", "goo"), { query: "goo", completion: "google.com" });
  assert.deepEqual(inlineOffer("gle.com", "Goo"), { query: "Goo", completion: "Google.com" });
});

test("an answer with no completion still reaches the field, so it drops a suffix that answer no longer backs", () => {
  assert.deepEqual(inlineOffer("", "goo"), { query: "goo", completion: "" });
});

test("an answer for shorter text stays on offer, and the field's editor decides whether it still fits what was typed", () => {
  assert.deepEqual(inlineOffer("ogle.com", "go"), { query: "go", completion: "google.com" });
});

test("no offer before the omnibox has answered for any text", () => {
  assert.equal(inlineOffer("", ""), null);
  assert.equal(inlineOffer("x", ""), null);
});

test("the completion highlight is the accent at 30% alpha", () => {
  assert.equal(withAlpha("#007AFF", 0.3), "rgba(0, 122, 255, 0.3)");
  assert.equal(withAlpha("#0A84FF", 0.3), "rgba(10, 132, 255, 0.3)");
});
