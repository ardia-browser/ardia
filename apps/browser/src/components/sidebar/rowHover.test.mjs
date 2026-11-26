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
  assert.doesNotMatch(body, /(?<!backToPin\.|cell\.)\bhovered\b/, "TabRow reads no row hover state, so a hover never re-renders it");
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

test("a row's Surface renders only when its own look changes, not when the row's children do", () => {
  const row = src("./SidebarRow.tsx");
  const body = row.slice(row.indexOf("export function useRowSurfaceLayer"), row.indexOf("\n}\n", row.indexOf("export function useRowSurfaceLayer")));
  assert.match(body, /return useMemo\(/);
  assert.match(body, /\[fill, cornerRadius, border, stroke, selected, selectedBorder, shadowColor, shadowOpacity, shadowRadius\]/);
  assert.equal(body.match(/<Surface\b/g)?.length, 1);
});

test("a tab row reads nothing at mount that only a hover, a split or a press needs", () => {
  const row = src("./TabRow.tsx");
  const body = row.slice(row.indexOf("export const TabRow = memo"), row.indexOf("const AWAY_FRAME"));
  assert.match(body, /tabPressView\(\{ windowId, tab, hitSlop: rowGapSlop\(0\), selected, press, inSplit: !!\(flags & IN_SPLIT\), plainTooltip, onPressChange: setPressed, children: \(/);
  assert.match(body, /const surface = useRowSurfaceLayer\(/);
  assert.doesNotMatch(body, /<SidebarRowSurface/);
  assert.doesNotMatch(body, /<TabPressArea|<PreviewFade|usePressScaleMotion/);
  const hover = src("./hoverController.ts");
  const cell = hover.slice(hover.indexOf("export function useRowHoverCell"), hover.indexOf("export function useGroupHover"));
  assert.doesNotMatch(cell, /useCardTarget|useSettings|useMedia\(/);
  assert.match(cell, /const target = cardTargetNow\(latest\.current\.rowTarget\);/);
  const parts = src("./RowHoverParts.tsx");
  assert.doesNotMatch(parts, /useTabCloseControl/);
  assert.match(parts, /export const RowHoverFill = memo\(/);
  assert.match(parts, /export const RowCloseSlot = memo\(/);
});

test("a drag wakes only the rows whose source, landing or split mark it changes", async () => {
  await import("../../test-native/index.ts");
  const { createDragMarks, watchMarks, markOf } = await import("../../state/sidebar/dragMarks.ts");
  const marks = createDragMarks();
  const woken = [];
  const offs = ["tab:a", "tab:b", "tab:c"].map((key) => watchMarks(marks)(key, () => woken.push(key)));
  marks.setState({ sources: new Set(["tab:a"]) });
  assert.deepEqual(woken, ["tab:a"]);
  marks.setState({ split: { key: "tab:b", side: "left" } });
  assert.deepEqual(woken, ["tab:a", "tab:b"]);
  assert.equal(markOf(marks.getState(), "tab:b"), 4);
  marks.setState({ pins: true });
  assert.deepEqual(woken, ["tab:a", "tab:b"]);
  offs.forEach((off) => off());
});

test("a selection change re-renders a row's hover fill only while it shows, and the row's hit slop stays one object", () => {
  const parts = src("./RowHoverParts.tsx");
  assert.match(parts, /if \(!cell\.plain \|\| !\(hovered \|\| pressed\)\) return null;/);
  assert.match(parts, /continuousCorners\(radius\)/);
  const row = src("./TabRow.tsx");
  assert.match(row, /cell\.plain = plain;/);
  assert.match(row, /const gapSlops = new Map<number, Insets>\(\);/);
});

test("a tab row's content fade is its frame: no extra view re-renders with the row", () => {
  const row = src("./TabRow.tsx");
  const body = row.slice(row.indexOf("export const TabRow = memo"), row.indexOf("const AWAY_FRAME"));
  assert.match(body, /\{surface\}\n\s*\{previewFade\(preview, <>/);
  assert.match(body, /<\/>, rowSurfaceFrame\(textOnly \? TAB_ROW\.contentLeft - TAB_ROW\.titleGap : TAB_ROW\.contentLeft\)\)\}/);
  assert.doesNotMatch(body, /<View style=\{rowSurfaceFrame/);
});
