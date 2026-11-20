import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { rowHoverCell, cellHovered } = await import("./hoverController.ts");

const src = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a row's hover cell wakes its readers only when the hover changes", () => {
  const cell = rowHoverCell("w1");
  let woken = 0;
  cell.readers.add(() => woken++);
  cell.readers.add(() => woken++);
  cell.set(true);
  assert.equal(woken, 2);
  assert.equal(cellHovered(cell), true);
  cell.set(true);
  assert.equal(woken, 2);
  cell.set(false);
  assert.equal(woken, 4);
  assert.equal(cellHovered(cell), false);
  cell.refresh();
  assert.equal(woken, 6);
});

test("hovering a tab row renders only its fill and close slot, never the row", () => {
  const row = src("./TabRow.tsx");
  const body = row.slice(row.indexOf("export const TabRow = memo"), row.indexOf("const AWAY_FRAME"));
  assert.match(body, /useRowHoverCell\(windowId,/);
  assert.doesNotMatch(body, /(?<!backToPin\.)\bhovered\b/, "TabRow reads no row hover state, so a hover never re-renders it");
  assert.match(body, /<RowHoverFill cell=\{cell\}/);
  assert.match(body, /<RowCloseSlot cell=\{cell\}/);
});

test("the close button appears at once and costs no wrapper stack", () => {
  assert.doesNotMatch(src("../ui/HoverSlot.tsx"), /Animated|Appear/);
  const close = src("./RowCloseButton.tsx");
  assert.doesNotMatch(close, /HoverFill|<View/);
  assert.doesNotMatch(close, /Animated|usePressScaleMotion/, "the close button answers a press with its pressed fill, no squish");
  const parts = src("./RowHoverParts.tsx");
  assert.doesNotMatch(parts, /Animated|\bHoverFill\b/, "the row's hover fill is a plain view, shown and hidden at once");
});

test("icon buttons have no press squish and mount no fill before their first hover or press; text buttons squish only in the bounce press motion", () => {
  const button = src("../ui/Button.tsx");
  const icon = button.slice(button.indexOf("function IconButtonView"), button.indexOf("const TEXT_LOOKS"));
  assert.doesNotMatch(icon, /Animated|usePressScaleMotion|usePressMotion/);
  assert.match(button, /usePressScaleMotion\(usePressMotion\(\) === "bounce", buttonMotion\.controlPressScale\)/);
  assert.equal(button.match(/\{lit \? <HoverFill /g)?.length, 2);
  assert.doesNotMatch(button, /animatedFace/);
});
