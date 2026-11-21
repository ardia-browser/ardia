import assert from "node:assert/strict";
import { test } from "node:test";
const { hasVisibleMembers, heldWideTab, keyedWidths, layoutStrip, nameGrowth, namesStayTight, withRoomyNames, overflowIn, stripOverflow, stripTabWidths, underPressure, withOverflowCounts, withoutTabs } = await import("./stripGroups.ts");
const { COMPACT_CHIP, GAP, GROUP_TITLE_MAX, GROUP_TITLE_TIGHT, MAX_CHIP, NEW_TAB_ROOM, SELECTED_MIN_CHIP, SELECTED_STEPS, SELECTED_TIGHT_CHIP, TITLED_CHIP } = await import("./tokens.ts");
const { needingTitles } = await import("../../state/tabs/topStrip.ts");

const tab = (id) => ({ kind: "tab", id, group: null });
const measured = (needs = []) => ({ groupChip: () => undefined, folderChip: () => undefined, needsTitle: (id) => needs.includes(id) });
const widths = (o) => stripTabWidths({ pageWidth: 1000, dockWidth: 0, groups: [], compactUnits: 0, titledUnits: 0, selectedShown: false, fixed: 0, gap: GAP, plus: NEW_TAB_ROOM, min: COMPACT_CHIP, titledMin: TITLED_CHIP, selectedMin: SELECTED_MIN_CHIP, max: MAX_CHIP, ...o });

test("a tab whose favicon is shared or missing needs its title; a tab with its own favicon doesn't", () => {
  assert.deepEqual(needingTitles([["a", "gh"], ["b", "gh"], ["c", "docs"], ["d", ""], ["e", "mail"]]), ["a", "b", "d"]);
  assert.deepEqual(needingTitles([["a", "x"], ["b", "y"]]), []);
});

test("the active tab takes its full width first and the rest share the room evenly while above every minimum", () => {
  assert.deepEqual(widths({ compactUnits: 2, titledUnits: 2, selectedShown: true }), { chip: 173, titled: 173, selected: 173 });
  assert.deepEqual(widths({ compactUnits: 3, titledUnits: 2, selectedShown: true }), { chip: 148, titled: 148, selected: MAX_CHIP });
});

test("as the room runs out each class stops at its own minimum: favicon-only tabs first go down to the compact width", () => {
  const w = widths({ compactUnits: 8, titledUnits: 4, selectedShown: true });
  assert.equal(w.selected, SELECTED_MIN_CHIP);
  assert.equal(w.titled, TITLED_CHIP);
  assert.ok(w.chip > COMPACT_CHIP && w.chip < TITLED_CHIP);
  const room = 1000 - NEW_TAB_ROOM - GAP;
  assert.ok(Math.abs(8 * w.chip + 4 * w.titled + w.selected + 13 * GAP - room) <= 10);
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

test("tabs that would get less than a readable title move into the open tabs menu, farthest from the selected tab first", () => {
  const tabs = Array.from({ length: 12 }, (_, i) => tab(`t${i}`));
  const needs = tabs.map((t) => t.id);
  const { hidden, selectedMin } = stripOverflow(tabs, "t3", 900, measured(needs), null);
  assert.ok(hidden.size > 0);
  assert.equal(selectedMin, SELECTED_TIGHT_CHIP);
  assert.ok(!hidden.has("t3"));
  assert.ok(hidden.has("t11"));
  const kept = withoutTabs(tabs, hidden).map((t) => t.id);
  assert.ok(kept.includes("t2") && kept.includes("t4"));
  const strip = layoutStrip(withoutTabs(tabs, hidden), "t3", 900, measured(needs), null, undefined, "t3", selectedMin);
  assert.ok(strip.tabsEnd + GAP + NEW_TAB_ROOM <= 900.5);
  for (const id of kept) if (id !== "t3") assert.ok(strip.tabWidth(id) >= TITLED_CHIP);
  assert.equal(stripOverflow(tabs.slice(0, 3), "t0", 900, measured(needs), null).hidden.size, 0);
  assert.equal(stripOverflow(tabs, "t3", 900, measured([]), null).hidden.size, 0);
});

test("the selected tab gives back its extra width before a neighbour is hidden, and keeps it when the window can afford it", () => {
  const tabs = Array.from({ length: 7 }, (_, i) => tab(`t${i}`));
  const needs = tabs.map((t) => t.id);
  const roomy = stripOverflow(tabs, "t0", 1400, measured(needs), null);
  assert.deepEqual([roomy.hidden.size, roomy.selectedMin], [0, SELECTED_MIN_CHIP]);
  const atMin = (page) => layoutStrip(tabs, "t0", page, measured(needs), null, undefined, "t0", SELECTED_MIN_CHIP);
  const page = Math.ceil(atMin(2000).tabsEnd - (MAX_CHIP - TITLED_CHIP) * 6 + GAP + NEW_TAB_ROOM) - 20;
  const tight = stripOverflow(tabs, "t0", page, measured(needs), null);
  assert.equal(tight.hidden.size, 0);
  assert.ok(tight.selectedMin < SELECTED_MIN_CHIP && tight.selectedMin >= SELECTED_TIGHT_CHIP);
  const strip = layoutStrip(tabs, "t0", page, measured(needs), null, undefined, "t0", tight.selectedMin);
  assert.ok(strip.tabsEnd + GAP + NEW_TAB_ROOM <= page + 0.5);
  assert.ok(strip.selected < MAX_CHIP);
});

test("a group counts the members the strip moved into the open tabs menu", () => {
  const group = { kind: "group", id: "g", collapsed: false, members: [tab("a"), tab("b"), tab("c")] };
  assert.equal(overflowIn(group, new Set(["b", "c", "x"])), 2);
  assert.equal(overflowIn(group, new Set()), 0);
  assert.equal(underPressure({ hidden: new Set(), selectedMin: SELECTED_MIN_CHIP }), false);
  assert.equal(underPressure({ hidden: new Set(), selectedMin: SELECTED_TIGHT_CHIP }), true);
  assert.equal(underPressure({ hidden: new Set(["a"]), selectedMin: SELECTED_MIN_CHIP }), true);
});

function overflowOneByOne(entries, activeId, pageWidth, measured, wideId = activeId) {
  const fits = (hidden, selectedMin) =>
    layoutStrip(withoutTabs(entries, hidden), activeId, pageWidth, withOverflowCounts(measured, entries, hidden), null, undefined, wideId, selectedMin).tabsEnd + GAP + NEW_TAB_ROOM <= pageWidth + 0.5;
  const roomy = SELECTED_STEPS.find((step) => fits(new Set(), step));
  if (roomy !== undefined) return { hidden: new Set(), selectedMin: roomy };
  const tight = SELECTED_STEPS.at(-1);
  const shown = entries.flatMap((e) => (e.kind === "group" ? (e.collapsed ? [] : e.members) : [e]));
  const order = shown.flatMap((m) => (m.kind === "tab" ? [m.id] : m.tabIds));
  const anchor = Math.max(0, order.indexOf(wideId));
  const candidates = shown
    .flatMap((m) => (m.kind === "tab" && m.id !== activeId && m.id !== wideId && measured.needsTitle(m.id) ? [m.id] : []))
    .sort((a, b) => Math.abs(order.indexOf(b) - anchor) - Math.abs(order.indexOf(a) - anchor) || order.indexOf(b) - order.indexOf(a));
  const hidden = new Set();
  for (const id of candidates) {
    hidden.add(id);
    if (fits(hidden, tight)) break;
  }
  return { hidden, selectedMin: tight };
}

test("the overflow hides exactly what laying the strip out after each hidden tab would, across random strips", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let run = 0; run < 400; run++) {
    const entries = [];
    const ids = [];
    let next = 0;
    const newTab = (group) => { const id = `t${next++}`; ids.push(id); return { kind: "tab", id, group }; };
    const groups = 1 + Math.floor(random() * 6);
    for (let g = 0; g < groups; g++) {
      if (random() < 0.4) {
        const gid = `g${g}`;
        const members = Array.from({ length: 1 + Math.floor(random() * 5) }, () => newTab(gid));
        if (random() < 0.15) { const a = `t${next++}`, b = `t${next++}`; ids.push(a, b); members.push({ kind: "split", id: `s${g}`, tabIds: [a, b], group: gid }); }
        entries.push({ kind: "group", id: gid, collapsed: random() < 0.2, members });
      } else {
        for (let i = 0; i < 1 + Math.floor(random() * 6); i++) entries.push(newTab(null));
      }
    }
    const needs = new Set(ids.filter(() => random() < 0.7));
    const chips = new Map(entries.filter((e) => e.kind === "group").map((e) => [e.id, random() < 0.8 ? 60 + Math.floor(random() * 90) : undefined]));
    const measured = { groupChip: (id) => chips.get(id), folderChip: () => undefined, needsTitle: (id) => needs.has(id) };
    const visible = entries.flatMap((e) => (e.kind === "group" ? (e.collapsed ? [] : e.members) : [e])).flatMap((m) => (m.kind === "tab" ? [m.id] : m.tabIds));
    const activeId = visible[Math.floor(random() * visible.length)] ?? ids[0];
    const pageWidth = 260 + Math.floor(random() * 1400);
    const fast = stripOverflow(entries, activeId, pageWidth, measured, null);
    const slow = overflowOneByOne(entries, activeId, pageWidth, measured);
    if (process.env.OC_DUMP && run === 295) console.log(JSON.stringify({ entries, needs: [...needs], chips: [...chips], activeId, pageWidth, fast: [...fast.hidden], slow: [...slow.hidden] }));
    assert.deepEqual([[...fast.hidden].sort(), fast.selectedMin], [[...slow.hidden].sort(), slow.selectedMin], `run ${run} at ${pageWidth} pt`);
  }
});

test("a thousand titled tabs at 600 pt overflow in about a single layout's time", () => {
  const tabs = Array.from({ length: 1000 }, (_, i) => tab(`t${i}`));
  const needs = tabs.map((t) => t.id);
  const m = measured(needs);
  const fastest = (run) => {
    run();
    let best = Infinity;
    for (let i = 0; i < 9; i++) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  const layout = fastest(() => layoutStrip(tabs, "t500", 600, m, null));
  const overflow = fastest(() => stripOverflow(tabs, "t500", 600, m, null));
  assert.ok(overflow < 4 * layout, `overflow took ${overflow.toFixed(2)} ms against ${layout.toFixed(2)} ms for one layout`);
});

test("a group whose members all moved into the open tabs menu keeps them as its drop anchor, and its span stays the header's", () => {
  const group = { kind: "group", id: "g", collapsed: false, members: [tab("b"), tab("c")] };
  const entries = [tab("a"), group, tab("d")];
  const shown = withoutTabs(entries, new Set(["b", "c"]));
  const strip = layoutStrip(shown, "a", 350, measured(), null);
  assert.deepEqual(strip.top.slots[1].tabIds, ["b", "c"]);
  assert.equal(strip.top.slots[1].tabIds[0], "b", "a group dropped right before it lands before its first tab, not at the end");
  assert.deepEqual(strip.spanOf("b"), [strip.top.lefts[1], strip.top.slots[1].width]);
  assert.equal(withoutTabs(entries, new Set(["a"]))[0], group, "an untouched group stays the same entry");
});

test("strips with a thousand groups overflow in about a single layout's time, chip widths found by key", () => {
  const entries = Array.from({ length: 1000 }, (_, g) => ({ kind: "group", id: `g${g}`, collapsed: g % 3 === 0, members: [tab(`g${g}a`), tab(`g${g}b`), tab(`g${g}c`)] }));
  const ids = new Set(entries.flatMap((e) => e.members.map((m) => m.id)));
  const groupIds = entries.map((e) => e.id);
  const widths = groupIds.map((_, i) => 70 + (i % 40));
  const direct = new Map(groupIds.map((id, i) => [id, widths[i]]));
  assert.equal(keyedWidths(groupIds, widths)("g41"), 71);
  assert.equal(keyedWidths(groupIds, widths)("missing"), undefined);
  const fastest = (run) => {
    run();
    let best = Infinity;
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };
  const layout = fastest(() => layoutStrip(entries, "g1a", 600, { groupChip: (id) => direct.get(id), folderChip: () => undefined, needsTitle: (id) => ids.has(id) }, null));
  const keyed = { groupChip: keyedWidths(groupIds, widths), folderChip: keyedWidths([], []), needsTitle: (id) => ids.has(id) };
  const overflow = fastest(() => stripOverflow(entries, "g1a", 600, keyed, null));
  assert.ok(overflow < 4 * layout, `overflow took ${overflow.toFixed(2)} ms against ${layout.toFixed(2)} ms for one layout`);
});

test("a group whose members all overflowed takes no member room from its neighbours and stays expanded with its anchor", () => {
  const group = { kind: "group", id: "g", collapsed: false, members: [tab("b"), tab("c")] };
  const rest = Array.from({ length: 4 }, (_, i) => tab(`t${i}`));
  const chip90 = { groupChip: () => 90, folderChip: () => undefined, needsTitle: () => false };
  const shown = withoutTabs([tab("a"), group, ...rest], new Set(["b", "c"]));
  const bare = layoutStrip([tab("a"), { kind: "group", id: "g", collapsed: true, members: [] }, ...rest], "a", 520, chip90, null);
  const strip = layoutStrip(shown, "a", 520, chip90, null);
  assert.equal(strip.chip, bare.chip);
  assert.ok(strip.chip > COMPACT_CHIP);
  assert.equal(shown[1].collapsed, false);
  assert.deepEqual(strip.top.slots[1].tabIds, ["b", "c"]);
  assert.equal(hasVisibleMembers(shown[1]), false);
  assert.equal(hasVisibleMembers(group), true);
});

test("after the strip widens, a long group name gets its full room back even beside short names that can't grow", () => {
  const LONG = 150;
  const SHORT = 40;
  const naturals = new Map([["long", LONG], ...Array.from({ length: 5 }, (_, i) => [`s${i}`, SHORT])]);
  const entries = [...naturals.keys()].map((id) => ({ kind: "group", id, collapsed: true, members: [tab(`${id}-1`)] }));
  const chipFor = (tight) => (id) => 40 + Math.min(naturals.get(id), tight ? GROUP_TITLE_TIGHT : GROUP_TITLE_MAX);
  const measuresFor = (tight) => ({ groupChip: chipFor(tight), folderChip: () => undefined, needsTitle: () => false });
  const step = (tight, page, growth) => {
    const m = measuresFor(tight);
    return namesStayTight(tight, stripOverflow(entries, "x", page, m, null), () => stripOverflow(entries, "x", page, withRoomyNames(m, growth), null));
  };
  const measured = (id) => naturals.get(id);
  const unmeasured = () => undefined;
  let tight = step(false, 300, measured);
  assert.equal(tight, true, "narrow: names are capped");
  assert.equal(nameGrowth(SHORT), 0);
  assert.equal(nameGrowth(LONG), GROUP_TITLE_MAX - GROUP_TITLE_TIGHT);
  assert.equal(nameGrowth(undefined), GROUP_TITLE_MAX - GROUP_TITLE_TIGHT);
  const pageAt = (target) => { for (let page = 300; page < 2400; page += 2) if (!step(true, page, target)) return page; return Infinity; };
  const released = pageAt(measured);
  assert.ok(released < pageAt(unmeasured), "counting each name's real growth releases the cap at a narrower width than charging every group 40 pt");
  tight = step(true, released, measured);
  assert.equal(tight, false, "widened: the long name runs to 120 pt again");
});

test("with earlier tabs in the open tabs menu, closing the selected tab holds its slot for the next visible tab, not a hidden one", () => {
  const tabs = ["a", "b", "c", "d", "e", "f"].map(tab);
  const needs = tabs.map((t) => t.id);
  const fit = stripOverflow(tabs, "e", 400, measured(needs), null);
  assert.deepEqual([...fit.hidden].sort(), ["a", "b", "c"]);
  const shown = layoutStrip(withoutTabs(tabs, fit.hidden), "e", 400, measured(needs), null, undefined, "e", fit.selectedMin);
  const wide = { tabId: "e", slot: shown.top.slots.findIndex((s) => s.tabIds.includes("e")) };
  const closedE = tabs.filter((t) => t.id !== "e");
  const holding = heldWideTab(closedE, wide, fit.hidden);
  assert.deepEqual(holding, { tabId: "f", atEnd: false });
  const held = layoutStrip(withoutTabs(closedE, fit.hidden), "f", 400, measured(needs), null, shown.widths, holding.tabId, fit.selectedMin);
  assert.equal(held.tabWidth("f"), shown.tabWidth("e"));
});
