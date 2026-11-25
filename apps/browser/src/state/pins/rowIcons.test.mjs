import assert from "node:assert/strict";
import { test } from "node:test";
import { drawnIcon, ghostIcon, ghostTileIcon, hidesRowIcon, isTextOnlyRow, NO_ROW_ICON, ownIcon } from "./rowIcons.ts";
import { iconValue } from "../automation/workspaceOps.ts";

const row = { pin: { as: "row" }, customIcon: NO_ROW_ICON, url: "https://a.example/", pinnedUrl: "https://a.example/" };
const tile = { ...row, pin: { as: "tile" } };

test("No Icon hides the icon of a pinned row only", () => {
  assert.equal(isTextOnlyRow(row), true);
  assert.equal(hidesRowIcon(row), true);
  assert.equal(isTextOnlyRow(tile), false);
  assert.equal(isTextOnlyRow({ ...row, pin: null }), false);
  assert.equal(isTextOnlyRow({ ...row, customIcon: "symbol:star" }), false);
});

test("a text-only row away from its pinned page shows its icon again, for Back to Pinned URL", () => {
  assert.equal(hidesRowIcon({ ...row, url: "https://a.example/other" }), false);
});

test("everywhere else the favicon stands in for No Icon", () => {
  assert.equal(drawnIcon(NO_ROW_ICON), null);
  assert.equal(drawnIcon("🚀"), "🚀");
  assert.equal(drawnIcon(null), null);
  assert.equal(ownIcon(row), NO_ROW_ICON);
  assert.equal(ownIcon(tile), null);
  assert.equal(ownIcon({ ...tile, customIcon: "🚀" }), "🚀");
});

test("a text-only row that is recording or has a Peek open shows its icon again, so the capture dot and the Peek mark have somewhere to sit", () => {
  assert.equal(hidesRowIcon(row, true), false);
  assert.equal(hidesRowIcon(row, false), true);
});

test("the drag ghost of a text-only row draws no icon, and every other ghost keeps its icon", () => {
  assert.equal(ghostIcon(row, true), null);
  assert.deepEqual(ghostIcon({ ...row, customIcon: "🚀" }, true), { icon: "🚀" });
  assert.deepEqual(ghostIcon(tile, false), { icon: NO_ROW_ICON });
  assert.deepEqual(ghostIcon(row, false), { icon: NO_ROW_ICON });
  assert.equal(ghostIcon(undefined, false), null);
});

test("a text-only row's ghost turned tile still draws the tab's icon, which falls back to its favicon", () => {
  assert.equal(ghostIcon(row, true), null, "the row shape stays text-only");
  assert.deepEqual(ghostTileIcon(row), { icon: NO_ROW_ICON });
  assert.equal(drawnIcon(ghostTileIcon(row).icon), null, "No Icon draws nothing itself, so TabIcon shows the favicon");
  assert.deepEqual(ghostTileIcon({ ...row, customIcon: "🚀" }), { icon: "🚀" });
  assert.equal(ghostTileIcon(undefined), null);
});

test("No Icon isn't a symbol anyone can pick, so the text format symbol stays a row icon", () => {
  const textformat = "symbol:textformat";
  assert.equal(iconValue(textformat), textformat);
  assert.equal(isTextOnlyRow({ ...row, customIcon: textformat }), false);
  assert.equal(drawnIcon(textformat), textformat);
  assert.notEqual(iconValue(NO_ROW_ICON), NO_ROW_ICON);
});
