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

test("a folder's bar takes its menu on a right-click and closes the folder on a click, and a closed folder's icon still opens it", () => {
  const bar = functionText("GroupBar");
  assert.match(bar, /onContextMenu=\{\(\) => void openGroupMenu\(windowId, span\.group\)\}/);
  assert.match(bar, /onPress=\{\(\) => updateGroup\(span\.group, \{ collapsed: true \}\)\}/);
  const square = functionText("OpenSquare");
  assert.match(square, /onPress=\{\(\) => actions\.open\(item\)\}/);
  assert.match(square, /onContextMenu=\{\(\) => void \(item\.kind === "group" && openGroupMenu\(windowId, item\.groupId\)\)\}/);
});

test("the profile switcher and its divider show at the strip's foot only when the full sidebar shows profile dots", () => {
  const strip = functionText("IconStrip");
  assert.match(strip, /const switcherShown = useProfileDotsShown\(\);/);
  const gated = strip.slice(strip.indexOf("{switcherShown ? ("), strip.indexOf(") : null}", strip.indexOf("{switcherShown ? (")));
  assert.match(gated, /<StripDivider \/>/);
  assert.match(gated, /<SpaceSquare /);
  assert.equal(strip.split("<SpaceSquare").length - 1, 1, "no badge outside the gate");
});

test("each folder's bar is one piece beside its tabs, and a nested folder's draws over its parent's", async () => {
  const { stripBarSpans, ICON_STRIP } = await import("./iconStripGeometry.ts");
  const outer = { group: "o", color: "blue" };
  const inner = { group: "i", color: "red" };
  const items = [{ bars: [] }, { bars: [outer] }, { bars: [outer, inner] }, { bars: [outer, inner] }, { bars: [outer] }, { bars: [] }];
  const tops = [0, 34, 68, 102, 136, 170];
  const end = (top) => top + ICON_STRIP.square - 3;
  assert.deepEqual(stripBarSpans(items, tops), [
    { group: "o", color: "blue", depth: 0, top: 37, bottom: end(136) },
    { group: "i", color: "red", depth: 1, top: 71, bottom: end(102) },
  ]);
});
