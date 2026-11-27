import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
await import("../../test-native/index.ts");
const { folderInk, folderPalette } = await import("./tokens.ts");

const ts = createRequire(import.meta.url)("typescript");
const source = readFileSync(new URL("./IconStrip.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("IconStrip.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const functionText = (name) => {
  let found = "";
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n.getText(file);
    ts.forEachChild(n, visit);
  };
  visit(file);
  return found;
};

test("a folder without a colour draws its bar in the same colour as its folder icon, not a grey", async () => {
  const theme = { dark: true, powerUpColor: "#D45F8A", accent: "#0A84FF", windowTint: ["#3E2F32", "#3E2F32"] };
  for (const color of [null, "red", "blue"]) {
    assert.deepEqual(folderInk(color, theme, "profile"), folderPalette(color, theme.dark, theme.powerUpColor, "profile", theme.windowTint), String(color));
  }
  assert.notEqual(folderInk(null, theme, "profile").stroke.toLowerCase(), "#8e8e93");
  const bar = functionText("GroupBar");
  assert.match(bar, /useFolderInk\(span\.color as GroupColor \| null\)\.stroke/, "the bar takes the folder icon's ink");
  assert.doesNotMatch(bar, /textTertiary|groupTint/, "and no fallback of its own");
});

test("an open group's slot draws no folder, keeps its press, drag and context menu, and a closed one draws its icon", () => {
  const square = functionText("OpenSquare");
  assert.match(square, /head \? null :/, "an open group's head slot shows no icon");
  assert.match(square, /onContextMenu=\{\(\) => void \(item\.kind === "group" && openGroupMenu\(windowId, item\.groupId\)\)\}/);
  assert.match(square, /onPress=\{\(\) => actions\.open\(item, pressedWith\.current\)\}/);
  assert.match(square, /\{\.\.\.handlers\}/);
});

test("the profile switcher and its divider show at the strip's foot only when the full sidebar shows profile dots", () => {
  const strip = functionText("IconStrip");
  assert.match(strip, /const switcherShown = useProfileDotsShown\(\);/);
  const gated = strip.slice(strip.indexOf("{switcherShown ? ("), strip.indexOf(") : null}", strip.indexOf("{switcherShown ? (")));
  assert.match(gated, /<StripDivider \/>/);
  assert.match(gated, /<SpaceSquare /);
  assert.equal(strip.split("<SpaceSquare").length - 1, 1, "no badge outside the gate");
});

test("each group's bar is one piece from the top of its first slot to the bottom of its last, and a nested group's sits over its parent's", async () => {
  const { stripBarSpans } = await import("./iconStripGeometry.ts");
  const slots = [0, 34, 68, 102, 136, 170].map((top) => ({ top }));
  const blue = (first, last) => ({ color: "blue", first, last });
  const red = (first, last) => ({ color: "red", first, last });
  const spans = stripBarSpans([null, blue(true, false), blue(false, false), red(true, true), blue(false, true), null], slots, () => 30);
  assert.deepEqual(spans, [
    { color: "red", top: 105, bottom: 129 },
    { color: "blue", top: 37, bottom: 163 },
  ]);
  assert.deepEqual(stripBarSpans([null, { color: null, first: true, last: true }], slots, () => 28), [{ color: null, top: 37, bottom: 59 }], "a single kept tab gets its own short bar");
});
