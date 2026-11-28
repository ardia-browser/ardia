import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { cornersOf } = await import("./FrozenPage.tsx");

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a tab live in another window shows its picture with the card's corners, not square ones", () => {
  const card = source("./ContentCard.tsx");
  assert.match(card, /<FrozenPage [^>]*radius=\{frame\.radius\}/, "ContentCard passes the card radius TabPane rounds the live page with");
  const frozen = source("./FrozenPage.tsx");
  assert.match(frozen, /overflow: "hidden" \}, cornersOf\(radius, top\)\]/, "FrozenPage clips its picture and wash to those corners");
});

test("the picture rounds all four corners when it fills the card, and only the bottom two under a toolbar", () => {
  assert.deepEqual(cornersOf(14, 0), { borderRadius: 14 });
  assert.deepEqual(cornersOf(14, 44), { borderBottomLeftRadius: 14, borderBottomRightRadius: 14 });
});
