import assert from "node:assert/strict";
import { test } from "node:test";
const { layoutDock, layoutStrip, newTabPinned } = await import("./stripGroups.ts");
const { GAP, ITEM_HEIGHT, MIN_CHIP, NEW_TAB_ROOM } = await import("./tokens.ts");

const tab = (id, group = null) => ({ kind: "tab", id, group });
const folder = (id, tabIds, group) => ({ kind: "folder", id, tabIds, group });
const group = (id, members, collapsed = false) => ({ kind: "group", id, collapsed, members });
const dock = (ids, members = {}) => ({ kind: "dock", ids, members: new Map(Object.entries(members)) });
const measured = (groups = {}, folders = {}) => ({ groupChip: (id) => groups[id], folderChip: (id) => folders[id] });
const dockOf = (entries) => layoutDock(entries.find((e) => e.kind === "dock"));
const PAGE_LEAVING_TABS_1000_AFTER_PLUS = 1000 + NEW_TAB_ROOM - ITEM_HEIGHT;
const layout = (entries, activeId, m = measured(), page = PAGE_LEAVING_TABS_1000_AFTER_PLUS) => layoutStrip(entries, activeId, page, m, dockOf(entries));

test("tabs share the page after the new-tab button, rounded to half points and kept between the min and max chip", () => {
  const six = ["a", "b", "c", "d", "e", "f"].map((id) => tab(id));
  assert.equal(layout(six, "a").chip, 156.5);
  assert.equal(layout(six.slice(0, 3), "a").chip, 173);
  assert.equal(layout([...six, ...six.map((t) => tab(`${t.id}2`))], "a").chip, 96);
});

test("+ and the chevron take 58 pt: the 32 pt button, a 4 pt gap and the sidebar New Tab row's 22 pt chevron", () => {
  assert.equal(NEW_TAB_ROOM, 32 + 4 + 22);
  const six = ["a", "b", "c", "d", "e", "f"].map((id) => tab(id));
  const strip = layout(six, "a", measured(), 1000);
  assert.equal(strip.chip, 152.5);
  assert.equal(strip.tabsEnd, 6 * 152.5 + 5 * GAP);
  assert.ok(strip.tabsEnd + GAP + NEW_TAB_ROOM <= 1000);
});

test("+ and the chevron stay inline after the tabs while they fit, and pin to the trailing end once the tabs overflow at the min chip", () => {
  const tabs = (n) => Array.from({ length: n }, (_, i) => tab(`t${i}`));
  const fits = layout(tabs(9), "t0", measured(), 1000);
  assert.ok(fits.chip > MIN_CHIP);
  assert.equal(newTabPinned(fits.chip, fits.tabsEnd, 1000), false);
  const full = layout(tabs(9), "t0", measured(), 9 * MIN_CHIP + 9 * GAP + GAP + NEW_TAB_ROOM);
  assert.equal(full.chip, MIN_CHIP);
  assert.equal(newTabPinned(full.chip, full.tabsEnd, 9 * MIN_CHIP + 9 * GAP + GAP + NEW_TAB_ROOM), false);
  const over = layout(tabs(30), "t29", measured(), 1000);
  assert.equal(over.chip, MIN_CHIP);
  assert.ok(over.tabsEnd > 1000);
  assert.equal(newTabPinned(over.chip, over.tabsEnd, 1000), true);
  const closedWhileHeld = layout(tabs(9), "t0", measured(), 1000);
  assert.equal(newTabPinned(MIN_CHIP, closedWhileHeld.tabsEnd + 400, 1000), true);
});

test("+ and the chevron pin once Top Apps, pinned tiles or collapsed groups alone overflow, with no tab left to shrink", () => {
  const cells = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const roomy = layout([dock(cells)], "p0", measured(), 2000);
  assert.equal(roomy.tabsShrink, false);
  assert.equal(newTabPinned(roomy.chip, roomy.tabsEnd, 2000, roomy.tabsShrink), false);
  const tight = layout([dock(cells)], "p0", measured(), 200);
  assert.ok(tight.chip > MIN_CHIP);
  assert.ok(tight.tabsEnd + GAP + NEW_TAB_ROOM > 200);
  assert.equal(newTabPinned(tight.chip, tight.tabsEnd, 200, tight.tabsShrink), true);
  const withTabs = layout([dock(cells), tab("x")], "x", measured(), 2000);
  assert.equal(withTabs.tabsShrink, true);
});

test("the pinned dock takes its cells and its gap off the room and off every top slot's left", () => {
  const entries = [dock(["folder:f", "p1", "a"], { "folder:f": ["a", "b"] }), ...["x", "y", "z", "u", "v", "w"].map((id) => tab(id))];
  const strip = layout(entries, "x");
  assert.equal(strip.chip, 138.5);
  assert.deepEqual(strip.spanOf("x"), [110.5, 138.5]);
  assert.deepEqual(strip.spanOf("y"), [110.5 + 138.5 + 4, 138.5]);
  assert.equal(dockOf(entries).left, -110.5);
  assert.deepEqual(dockOf(entries).geometry.slots.map((s) => s.tabIds), [["a", "b"], ["p1"], ["a"]]);
});

test("a selected pinned tab reveals its own dock cell, and a tab only in a tile folder reveals the folder", () => {
  const entries = [dock(["folder:f", "p1", "a"], { "folder:f": ["a", "b"] }), tab("x")];
  const strip = layout(entries, "a");
  assert.deepEqual(strip.spanOf("a"), [72, 34]);
  assert.deepEqual(strip.spanOf("b"), [0, 34]);
  assert.deepEqual(strip.spanOf("p1"), [36, 34]);
  assert.equal(strip.spanOf("gone"), null);
});

test("an open group lays out its chip, its members and a nested folder holding the selected tab after the folder chip", () => {
  const entries = [tab("t1"), group("G", [tab("a", "G"), folder("F", ["b", "c"], "G"), tab("d", "G")]), tab("t2")];
  const strip = layout(entries, "c", measured({ G: 60 }, { F: 50 }));
  assert.equal(strip.chip, 156);
  assert.equal(strip.memberWidth(entries[1].members[1]), 212.5);
  assert.deepEqual(strip.top.lefts, [0, 163.5, 800.75]);
  assert.deepEqual(strip.top.slots.map((s) => s.width), [156, 629.25, 156]);
  assert.deepEqual(strip.top.slots[1].tabIds, ["a", "b", "c", "d"]);
  assert.deepEqual(strip.spanOf("c"), [390, 212.5]);
  assert.deepEqual(strip.spanOf("d"), [606.5, 156]);
  assert.deepEqual(strip.spanOf("t2"), [800.75, 156]);
  assert.deepEqual(strip.targets, [{ kind: "tab", id: "t1" }, { kind: "group", id: "G" }, { kind: "tab", id: "t2" }]);
});

test("a closed group shows only the member holding the selected tab, right after its chip", () => {
  const entries = [tab("t1"), group("G", [tab("a", "G"), folder("F", ["b", "c"], "G"), tab("d", "G")], true), tab("t2")];
  const strip = layout(entries, "c", measured({ G: 60 }, { F: 50 }));
  assert.equal(strip.chip, 173);
  assert.deepEqual(strip.top.slots.map((s) => s.width), [173, 300.5, 173]);
  assert.deepEqual(strip.spanOf("c"), [247, 229.5]);
});

test("a folder without the selected tab is only its chip, and a split takes two chips", () => {
  const entries = [group("G", [folder("F", ["b"], "G"), tab("a", "G")]), { kind: "split", id: "s", tabIds: ["x", "y"], group: null }];
  const strip = layout(entries, "a", measured({ G: 60 }, { F: 50 }));
  assert.equal(strip.memberWidth(entries[0].members[0]), 50);
  assert.equal(strip.top.slots[1].width, strip.chip * 2);
  assert.deepEqual(strip.targets, [{ kind: "group", id: "G" }, null]);
});

test("an unmeasured group or folder chip counts as zero wide until it is measured", () => {
  const entries = [group("G", [folder("F", ["b", "c"], "G")])];
  const strip = layout(entries, "c");
  assert.deepEqual(strip.spanOf("c"), [3.5 + 6.5, 6.5 + strip.chip]);
});

test("a held chip width keeps every tab where it was after a close, whatever room the close freed", () => {
  const six = ["a", "b", "c", "d", "e", "f"].map((id) => tab(id));
  const held = layoutStrip(six.slice(1), "b", 1000, measured(), null, 156.5);
  assert.equal(held.chip, 156.5);
  assert.deepEqual(held.spanOf("c"), [156.5 + 4, 156.5]);
  assert.equal(layoutStrip(six.slice(1), "b", 1000, measured(), null).chip, 173);
});
