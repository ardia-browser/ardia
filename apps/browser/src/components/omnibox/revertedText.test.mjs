import assert from "node:assert/strict";
import { test } from "node:test";
import { REVERT_WINDOW_MS, freshRevertWatch, readNativeText, wroteOverField } from "./revertedText.ts";

const at = (n) => ({ start: n, end: n });

function run(steps, start = 1000) {
  let watch = freshRevertWatch();
  const seen = [];
  for (const [i, step] of steps.entries()) {
    if (step === "js write") {
      watch = wroteOverField(watch);
      continue;
    }
    const [next, caret = at(next.length), now = start + i * 80] = step;
    const read = readNativeText(watch, next, caret, now);
    watch = read.watch;
    seen.push(read);
  }
  return seen;
}

const texts = (seen) => seen.map((s) => s.text);

test("the letters a stale first change erased are put back where they were, once, with the caret after them", () => {
  const seen = run([["e"], ["ex"], ["ea", at(2)], ["eam"]]);
  assert.deepEqual(texts(seen), ["e", "ex", "exa", "exam"]);
  assert.deepEqual(seen[2].restored, { at: 1, text: "x" });
  assert.deepEqual(seen.map((s) => s.caret), [null, null, 3, 4]);
  assert.deepEqual(seen.map((s) => s.restored).filter(Boolean).length, 1);
});

test("several erased letters come back in order", () => {
  assert.deepEqual(texts(run([["e"], ["ex"], ["exa"], ["em"]])), ["e", "ex", "exa", "exam"]);
});

test("once the field holds the restored text again, its changes pass through", () => {
  const seen = run([["e"], ["ex"], ["ea"], ["exam"], ["examp"]]);
  assert.deepEqual(texts(seen), ["e", "ex", "exa", "exam", "examp"]);
  assert.equal(run([["e"], ["ex"], ["ea"], ["eam"], ["examp"]])[4].text, "examp");
  assert.deepEqual(seen.slice(3).map((s) => s.caret), [null, null]);
});

test("an edit while letters are being restored ends the restoring and keeps what the field holds", () => {
  assert.deepEqual(texts(run([["e"], ["ex"], ["ea"], ["e"]])), ["e", "ex", "exa", "e"]);
});

test("ordinary typing, Backspace and a word deleted at the end pass through", () => {
  assert.deepEqual(texts(run([["e"], ["ex"], ["exa"], ["ex"], ["exa"], ["e"], ["ea"]])), ["e", "ex", "exa", "ex", "exa", "e", "ea"]);
});

test("a selection replaced or text typed in the middle is never taken for a stale change", () => {
  assert.equal(run([["e"], ["ex"], ["ea", { start: 1, end: 2 }]])[2].text, "ea");
  assert.equal(run([["e"], ["ex"], ["ea", at(1)]])[2].text, "ea");
});

test("nothing is restored when the field ever changed by more than one typed letter", () => {
  assert.equal(run([["exam"], ["examp"], ["examl"]])[2].text, "examl");
  assert.equal(run([["e"], ["exa"], ["em"]])[2].text, "em");
  assert.equal(run([["e"], ["ex", at(0)], ["ea"]])[2].text, "ea");
});

test("nothing is restored after JS wrote the field, as a completion, a reset or a scope does", () => {
  assert.equal(run([["e"], "js write", ["ex"], ["ea"]])[2].text, "ea");
});

test("a JS write while letters are being restored ends the restoring", () => {
  assert.deepEqual(texts(run([["e"], ["ex"], ["ea"], "js write", ["eam"]])), ["e", "ex", "exa", "eam"]);
});

test("the erased letter typed again is proven by the text not changing, so it is restored", () => {
  assert.deepEqual(texts(run([["g"], ["go"], ["go"], ["gog"], ["gogl"]])), ["g", "go", "goo", "goog", "googl"]);
});

test("a change that could be Backspace is never taken for a stale change", () => {
  assert.equal(run([["e"], ["ex"], ["exa"], ["ex"]])[3].text, "ex");
});

test("a composition that turns typed letters into other characters is never taken for a stale change", () => {
  assert.equal(run([["e"], ["ek"], ["eか"]])[2].text, "eか");
  assert.equal(run([["n"], ["ni"], ["n你"]])[2].text, "n你");
});

test("a revert is looked for only once, and only soon after the field's first change", () => {
  assert.equal(run([["e"], ["ex"], ["ea"], ["exam"], ["e"], ["ex"], ["ea"]])[6].text, "ea");
  assert.equal(run([["e"], ["ex"], ["ea"], ["exam"], ["exa"], ["ex"], ["e"]])[6].text, "e");
  assert.equal(run([["e", undefined, 0], ["ex", undefined, 50], ["ea", undefined, REVERT_WINDOW_MS + 1]])[2].text, "ea");
});
