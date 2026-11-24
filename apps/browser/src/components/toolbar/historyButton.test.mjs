import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const nav = readFileSync(new URL("./NavButtons.tsx", import.meta.url), "utf8");
const history = nav.slice(nav.indexOf("export const HistoryButton"));

test("back and forward answer on the press without moving their glyph", () => {
  assert.doesNotMatch(history, /onPressIn|onPressOut|pressOffset/);
  assert.doesNotMatch(readFileSync(new URL("./tokens.ts", import.meta.url), "utf8"), /pressTravel/);
});

test("the glyph handoff's two animated layers mount only while it runs, inside the memoised face", () => {
  assert.match(history, /handingOff \? \(\n\s*<View style=\{ICON_CENTER\}>/);
  assert.match(history, /setHandingOff\(true\);/);
  assert.match(history, /handoffMotion\.setValue\(0\);\n      setHandingOff\(false\);/);
  assert.match(history, /\[handingOff, handoff, icon, iconColor\],/);
  assert.equal((history.match(/<Animated\.View/g) ?? []).length, 2, "the resting glyph sits straight in the button's plate");
});
