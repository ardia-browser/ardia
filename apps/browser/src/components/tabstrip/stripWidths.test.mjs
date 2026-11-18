import assert from "node:assert/strict";
import { test } from "node:test";
const { heldWideTab, layoutStrip, stripTabWidths } = await import("./stripGroups.ts");
const { COMPACT_CHIP, GAP, MAX_CHIP, NEW_TAB_ROOM, SELECTED_MIN_CHIP, TITLED_CHIP } = await import("./tokens.ts");
const { needingTitles } = await import("../../state/tabs/topStrip.ts");

const tab = (id) => ({ kind: "tab", id, group: null });
const measured = (needs = []) => ({ groupChip: () => undefined, folderChip: () => undefined, needsTitle: (id) => needs.includes(id) });
const widths = (o) => stripTabWidths({ pageWidth: 1000, dockWidth: 0, groups: [], compactUnits: 0, titledUnits: 0, selectedShown: false, fixed: 0, gap: GAP, plus: NEW_TAB_ROOM, min: COMPACT_CHIP, titledMin: TITLED_CHIP, selectedMin: SELECTED_MIN_CHIP, max: MAX_CHIP, ...o });

test("a tab whose favicon is shared or missing needs its title; a tab with its own favicon doesn't", () => {
  assert.deepEqual(needingTitles([["a", "gh"], ["b", "gh"], ["c", "docs"], ["d", ""], ["e", "mail"]]), ["a", "b", "d"]);
  assert.deepEqual(needingTitles([["a", "x"], ["b", "y"]]), []);
});

test("every tab shares the room evenly while the even share is above every minimum", () => {
  assert.deepEqual(widths({ compactUnits: 2, titledUnits: 2, selectedShown: true }), { chip: 173, titled: 173, selected: 173 });
  assert.deepEqual(widths({ compactUnits: 3, titledUnits: 2, selectedShown: true }), { chip: 152.5, titled: 152.5, selected: 152.5 });
});

test("as the room runs out each class stops at its own minimum: favicon-only tabs first go down to the compact width", () => {
  const w = widths({ compactUnits: 10, titledUnits: 4, selectedShown: true });
  assert.equal(w.selected, SELECTED_MIN_CHIP);
  assert.equal(w.titled, TITLED_CHIP);
  assert.ok(w.chip > COMPACT_CHIP && w.chip < TITLED_CHIP);
  const room = 1000 - NEW_TAB_ROOM - GAP;
  assert.ok(Math.abs(10 * w.chip + 4 * w.titled + w.selected + 15 * GAP - room) <= 10);
  const full = widths({ compactUnits: 60, titledUnits: 10, selectedShown: true });
  assert.deepEqual(full, { chip: COMPACT_CHIP, titled: TITLED_CHIP, selected: SELECTED_MIN_CHIP });
});

test("a tab that needs its title keeps the titled width in the strip's geometry while the others are compact", () => {
  const tabs = Array.from({ length: 40 }, (_, i) => tab(`t${i}`));
  const strip = layoutStrip(tabs, "t20", 1000, measured(["t3", "t4"]), null);
  assert.equal(strip.tabWidth("t20"), SELECTED_MIN_CHIP);
  assert.equal(strip.tabWidth("t3"), TITLED_CHIP);
  assert.equal(strip.tabWidth("t5"), COMPACT_CHIP);
  assert.deepEqual(strip.spanOf("t5"), [3 * (COMPACT_CHIP + GAP) + 2 * (TITLED_CHIP + GAP), COMPACT_CHIP]);
});

test("while a close run is held, the wide slot stays at its place in the strip, whichever tab slides into it", () => {
  const before = ["a", "b", "c", "d"].map(tab);
  assert.deepEqual(heldWideTab(before, { tabId: "b", slot: 1 }), { tabId: "b", atEnd: false });
  const closedA = ["b", "c", "d"].map(tab);
  assert.deepEqual(heldWideTab(closedA, { tabId: "b", slot: 1 }), { tabId: "c", atEnd: false });
  const closedB = ["a", "c", "d"].map(tab);
  assert.deepEqual(heldWideTab(closedB, { tabId: "b", slot: 1 }), { tabId: "c", atEnd: false });
  const closedD = ["a", "b", "c"].map(tab);
  assert.deepEqual(heldWideTab(closedD, { tabId: "d", slot: 3 }), { tabId: "c", atEnd: true });
  const strip = layoutStrip(closedB, "a", 1000, measured(), null, { chip: COMPACT_CHIP, titled: TITLED_CHIP, selected: SELECTED_MIN_CHIP }, "c");
  assert.equal(strip.tabWidth("c"), SELECTED_MIN_CHIP);
  assert.equal(strip.tabWidth("a"), COMPACT_CHIP);
  assert.deepEqual(strip.spanOf("c"), [COMPACT_CHIP + GAP, SELECTED_MIN_CHIP]);
});
