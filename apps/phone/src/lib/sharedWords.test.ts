import assert from "node:assert/strict";
import test from "node:test";
import { actionWords, destinationWords, dismissWords, listWords, opensChoice, syncWords } from "./sharedWords.ts";

const tables = { actionWords, destinationWords, dismissWords, syncWords };

const allWords = (): [string, string][] => [
  ...Object.entries(tables).flatMap(([table, words]) => Object.entries(words).map(([key, value]): [string, string] => [`${table}.${key}`, value])),
  ["listWords.noResults", listWords.noResults],
  ["listWords.noResultsCue", listWords.noResultsCue("query")],
  ["listWords.loading", listWords.loading],
];

test("shared words use the typographic apostrophe, quotes and ellipsis the app's copy uses", () => {
  for (const [key, value] of allWords()) {
    assert.ok(!value.includes("'"), `${key} has a straight apostrophe`);
    assert.ok(!value.includes('"'), `${key} has a straight quote`);
    assert.ok(!value.includes("..."), `${key} has three dots for an ellipsis`);
  }
});

test("shared words spell Color the US way", () => {
  for (const [key, value] of allWords()) assert.ok(!/colour/i.test(value), `${key} spells colour`);
});

test("button words are title case", () => {
  for (const [key, value] of Object.entries({ ...actionWords, ...dismissWords, ...syncWords })) {
    for (const word of value.replace(/…$/, "").split(" ")) {
      if (["to", "a", "the", "with", "of", "in", "for", "and", "or"].includes(word)) continue;
      assert.match(word, /^[A-Z0-9]/, `${key}: “${word}” in “${value}”`);
    }
  }
});

test("Share hands off without an ellipsis; a label that opens another choice gets one", () => {
  assert.equal(actionWords.share, "Share");
  assert.equal(opensChoice("Delete All"), "Delete All…");
});

test("the in-flight page action is named Stop Loading everywhere", () => {
  assert.equal(actionWords.stopLoading, "Stop Loading");
});
