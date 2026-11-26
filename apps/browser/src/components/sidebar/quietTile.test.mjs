import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const ts = createRequire(import.meta.url)("typescript");

function source(path) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  return ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
}

function all(node, keep, out = []) {
  if (keep(node)) out.push(node);
  ts.forEachChild(node, (child) => void all(child, keep, out));
  return out;
}

const isJsx = (node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
const tagsIn = (file, node) => all(node, isJsx).map((n) => (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText(file));
const fn = (file, name) => all(file, (n) => ts.isFunctionDeclaration(n) && n.name?.getText(file) === name)[0];

test("a Minimalism mode Top Apps tile draws letters by default, its own letters when set, and the site's logo only with Site Logos (#3609)", () => {
  const file = source("./TileFace.tsx");
  const tile = fn(file, "LetterTile");
  assert.ok(tile, "LetterTile is gone");
  const text = tile.getText(file);
  assert.match(text, /logos \? \(\s*<LogoFace/, "the logo only when the setting asks for it");
  assert.match(text, /tileLettersOf\(\{ url, title, tileLetters \}\)/, "custom letters first, then the site's letter");
  assert.deepEqual(tagsIn(file, fn(file, "LogoFace")), ["TabIcon"]);
  assert.match(file.getText(), /useSettings\(\(s\) => s\.minimalismPinnedIcons === "logos"\)/);
});

test("a Minimalism mode pinned tab in the top strip follows the same choice", () => {
  const text = readFileSync(new URL("../tabstrip/PinnedFace.tsx", import.meta.url), "utf8");
  assert.match(text, /minimal && letters \?/);
  assert.match(text, /\{tileLettersOf\(tab\)\}/);
});
