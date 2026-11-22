import assert from "node:assert/strict";
import { test } from "node:test";
const { hasVisibleMembers, heldWideTab, keyedWidths, layoutStrip, nameGrowth, namesStayTight, withRoomyNames, overflowIn, stripOverflow, stripTabWidths, underPressure, withOverflowCounts, withoutTabs } = await import("./stripGroups.ts");
const { COMPACT_CHIP, GAP, GROUP_TITLE_MAX, GROUP_TITLE_TIGHT, MAX_CHIP, NEW_TAB_ROOM, SELECTED_MIN_CHIP, SELECTED_STEPS, SELECTED_TIGHT_CHIP, TITLE_MIN_CHIP, TITLED_CHIP } = await import("./tokens.ts");
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
  const layout = (hidden, selectedMin, titledMin, compactMin) =>
    layoutStrip(withoutTabs(entries, hidden), activeId, pageWidth, withOverflowCounts(measured, entries, hidden), null, undefined, wideId, selectedMin, titledMin, compactMin);
  const fitsIn = (strip) => strip.tabsEnd + GAP + NEW_TAB_ROOM <= pageWidth + 0.5;
  const fits = (hidden, selectedMin) => fitsIn(layout(hidden, selectedMin));
  const tight = SELECTED_STEPS.at(-1);
  const readable = (hidden, selectedMin, titledMin) => fitsIn(layout(hidden, selectedMin, titledMin, TITLE_MIN_CHIP));
  const favicons = layout(new Set(), tight).compactShown > 0;
  if (favicons) {
    const step = SELECTED_STEPS.find((s) => readable(new Set(), s, TITLED_CHIP));
    if (step !== undefined) return { hidden: new Set(), selectedMin: step, titledMin: TITLED_CHIP, compactMin: TITLE_MIN_CHIP };
    if (readable(new Set(), tight, TITLE_MIN_CHIP)) return { hidden: new Set(), selectedMin: tight, titledMin: TITLE_MIN_CHIP, compactMin: TITLE_MIN_CHIP };
  }
  const roomy = SELECTED_STEPS.find((step) => fits(new Set(), step));
  if (roomy !== undefined) return { hidden: new Set(), selectedMin: roomy, titledMin: TITLED_CHIP, compactMin: COMPACT_CHIP };
  if (!favicons && readable(new Set(), tight, TITLE_MIN_CHIP)) return { hidden: new Set(), selectedMin: tight, titledMin: TITLE_MIN_CHIP, compactMin: TITLE_MIN_CHIP };
  const shown = entries.flatMap((e) => (e.kind === "group" ? (e.collapsed ? [] : e.members) : [e]));
  const order = shown.flatMap((m) => (m.kind === "tab" ? [m.id] : m.tabIds));
  const anchor = Math.max(0, order.indexOf(wideId));
  const sorted = shown
    .flatMap((m) => (m.kind === "tab" && m.id !== activeId && m.id !== wideId && measured.needsTitle(m.id) ? [m.id] : []))
    .sort((a, b) => Math.abs(order.indexOf(b) - anchor) - Math.abs(order.indexOf(a) - anchor) || order.indexOf(b) - order.indexOf(a));
  const lastOfGroup = entries.flatMap((e) => {
    if (e.kind !== "group" || e.collapsed || !e.members.every((m) => m.kind === "tab" && sorted.includes(m.id))) return [];
    return [sorted.filter((id) => e.members.some((m) => m.id === id)).at(-1)];
  });
  const candidates = [...sorted.filter((id) => !lastOfGroup.includes(id)), ...sorted.filter((id) => lastOfGroup.includes(id))];
  const hidden = new Set();
  for (const id of candidates) {
    hidden.add(id);
    if (fits(hidden, tight)) break;
  }
  if (favicons && readable(hidden, tight, TITLED_CHIP)) return { hidden, selectedMin: tight, titledMin: TITLED_CHIP, compactMin: TITLE_MIN_CHIP };
  if (favicons && readable(hidden, tight, TITLE_MIN_CHIP)) return { hidden, selectedMin: tight, titledMin: TITLE_MIN_CHIP, compactMin: TITLE_MIN_CHIP };
  return { hidden, selectedMin: tight, titledMin: TITLED_CHIP, compactMin: COMPACT_CHIP };
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
    assert.deepEqual([[...fast.hidden].sort(), fast.selectedMin, fast.titledMin, fast.compactMin], [[...slow.hidden].sort(), slow.selectedMin, slow.titledMin, slow.compactMin], `run ${run} at ${pageWidth} pt`);
  }
});

const countingCalls = (m) => {
  const calls = { n: 0 };
  return [{ groupChip: (id) => (calls.n++, m.groupChip(id)), folderChip: (id) => (calls.n++, m.folderChip(id)), needsTitle: (id) => (calls.n++, m.needsTitle(id)) }, calls];
};
const callsOf = (m, run) => {
  const [counted, calls] = countingCalls(m);
  run(counted);
  return calls.n;
};

test("a thousand titled tabs at 600 pt overflow for about one layout's work, counted in calls into the strip's measures", () => {
  const tabs = Array.from({ length: 1000 }, (_, i) => tab(`t${i}`));
  const m = measured(tabs.map((t) => t.id));
  const layout = callsOf(m, (c) => layoutStrip(tabs, "t500", 600, c, null));
  const overflow = callsOf(m, (c) => stripOverflow(tabs, "t500", 600, c, null));
  assert.ok(layout <= 2 * tabs.length, `one layout made ${layout} calls for ${tabs.length} tabs`);
  assert.ok(overflow <= 2 * layout, `the overflow made ${overflow} calls against ${layout} for one layout`);
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

test("strips with a thousand groups overflow for about one layout's work, chip widths found by key", () => {
  const entries = Array.from({ length: 1000 }, (_, g) => ({ kind: "group", id: `g${g}`, collapsed: g % 3 === 0, members: [tab(`g${g}a`), tab(`g${g}b`), tab(`g${g}c`)] }));
  const ids = new Set(entries.flatMap((e) => e.members.map((m) => m.id)));
  const groupIds = entries.map((e) => e.id);
  const widths = groupIds.map((_, i) => 70 + (i % 40));
  assert.equal(keyedWidths(groupIds, widths)("g41"), 71);
  assert.equal(keyedWidths(groupIds, widths)("missing"), undefined);
  const keyed = { groupChip: keyedWidths(groupIds, widths), folderChip: keyedWidths([], []), needsTitle: (id) => ids.has(id) };
  const layout = callsOf(keyed, (c) => layoutStrip(entries, "g1a", 600, c, null));
  const overflow = callsOf(keyed, (c) => stripOverflow(entries, "g1a", 600, c, null));
  assert.ok(overflow <= 2 * layout, `the overflow made ${overflow} calls against ${layout} for one layout`);
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

const FILMED_STRIP_INSETS = 183;
const filmedPage = (windowWidth) => windowWidth - FILMED_STRIP_INSETS;
const tripStrip = () => {
  const own = (id, group = null) => ({ kind: "tab", id, group });
  const entries = [own("t1"), own("t2"), own("t3"), { kind: "group", id: "trip", collapsed: false, members: ["g1", "g2", "g3", "g4", "g5"].map((id) => own(id, "trip")) }, own("t5"), own("t6")];
  const favicons = { t1: "docpad", t2: "lexicon", t3: "crumbs", g1: "ferry", g2: "hostel", g3: "", g4: "", g5: "", t5: "", t6: "" };
  return { entries, favicons };
};
const TRIP_CHIP = 76;
const TRIP_NAME = 30;

function stripAfter(entries, favicons, windowWidths, tight = { names: false }) {
  let shown;
  for (const windowWidth of windowWidths) {
    const page = filmedPage(windowWidth);
    const needs = new Set(needingTitles(Object.entries(favicons)));
    for (let render = 0; render < 4; render++) {
      const m = { groupChip: () => TRIP_CHIP + (tight.names ? 0 : nameGrowth(TRIP_NAME)), folderChip: () => undefined, needsTitle: (id) => needs.has(id) };
      const fit = stripOverflow(entries, "t1", page, m, null);
      tight.names = namesStayTight(tight.names, fit, () => stripOverflow(entries, "t1", page, withRoomyNames(m, () => TRIP_NAME), null));
      const strip = layoutStrip(withoutTabs(entries, fit.hidden), "t1", page, withOverflowCounts(m, entries, fit.hidden), null, undefined, "t1", fit.selectedMin, fit.titledMin, fit.compactMin);
      const ids = entries.flatMap((e) => (e.kind === "group" ? e.members.map((t) => t.id) : [e.id]));
      shown = { page, fit, strip, needs, m, widths: Object.fromEntries(ids.map((id) => [id, fit.hidden.has(id) ? "menu" : strip.tabWidth(id)])) };
    }
  }
  return shown;
}

test("the filmed strip at 1180 and 760 pt lays out the same whether the window opened at that width or was resized to it", () => {
  const { entries, favicons } = tripStrip();
  const noFavicons = Object.fromEntries(Object.keys(favicons).map((id) => [id, ""]));
  const result = ({ fit, widths }) => ({ hidden: [...fit.hidden].sort(), selectedMin: fit.selectedMin, titledMin: fit.titledMin, compactMin: fit.compactMin, widths });
  for (const icons of [favicons, noFavicons]) {
    assert.deepEqual(result(stripAfter(entries, icons, [760])), result(stripAfter(entries, icons, [1180, 1100, 1000, 900, 800, 760])), "760 pt");
    assert.deepEqual(result(stripAfter(entries, icons, [1180])), result(stripAfter(entries, icons, [760, 900, 1050, 1180])), "1180 pt");
  }
  const tight = { names: false };
  stripAfter(entries, noFavicons, [760], tight);
  assert.deepEqual(result(stripAfter(entries, favicons, [760], tight)), result(stripAfter(entries, favicons, [1180, 760])), "favicons arriving after the window opened narrow land where narrowing with them loaded does");
  const narrow = stripAfter(entries, favicons, [760]);
  assert.deepEqual(result(narrow).hidden, ["g4", "g5", "t5", "t6"]);
  assert.equal(overflowIn(entries[3], narrow.fit.hidden), 2);
});

test("titled tabs in the filmed strip keep a readable width, and a tab shows only its icon only when every tab readable wouldn't fit", () => {
  const { entries, favicons } = tripStrip();
  for (let windowWidth = 700; windowWidth <= 1500; windowWidth += 10) {
    const { page, fit, strip, needs, m, widths } = stripAfter(entries, favicons, [windowWidth]);
    const shown = Object.entries(widths).filter(([, w]) => w !== "menu");
    for (const [id, w] of shown) if (needs.has(id)) assert.ok(w >= TITLE_MIN_CHIP, `${id} at ${windowWidth} pt is ${w} pt`);
    const iconOnly = shown.filter(([id, w]) => !needs.has(id) && id !== "t1" && w < TITLE_MIN_CHIP);
    if (!iconOnly.length) continue;
    const readable = { chip: TITLE_MIN_CHIP, titled: TITLE_MIN_CHIP, selected: SELECTED_STEPS.at(-1) };
    const allReadable = layoutStrip(withoutTabs(entries, fit.hidden), "t1", page, withOverflowCounts(m, entries, fit.hidden), null, readable, "t1", fit.selectedMin, fit.titledMin);
    assert.ok(allReadable.tabsEnd + GAP + NEW_TAB_ROOM > page + 0.5, `${iconOnly.map(([id]) => id)} show only an icon at ${windowWidth} pt though every tab fits at ${TITLE_MIN_CHIP} pt`);
    assert.ok(strip.tabsEnd + GAP + NEW_TAB_ROOM <= page + 0.5);
  }
  const roomy = stripAfter(entries, favicons, [1280]).widths;
  assert.ok(["t2", "t3", "g1", "g2"].every((id) => roomy[id] >= TITLE_MIN_CHIP), `at 1280 pt every favicon tab shows its title: ${JSON.stringify(roomy)}`);
  const wide = stripAfter(entries, favicons, [1180]);
  assert.equal(wide.fit.hidden.size, 0, "at 1180 pt every tab stays in the strip");
});

test("a group in the filmed strip keeps a tab showing while any tab outside it can still move into the menu", () => {
  const { entries, favicons } = tripStrip();
  const noFavicons = Object.fromEntries(Object.keys(favicons).map((id) => [id, ""]));
  for (const icons of [favicons, noFavicons]) {
    for (let windowWidth = 640; windowWidth <= 1180; windowWidth += 10) {
      const { fit } = stripAfter(entries, icons, [windowWidth]);
      const members = entries[3].members.map((t) => t.id);
      if (members.every((id) => fit.hidden.has(id))) assert.ok(["t2", "t3", "t5", "t6"].every((id) => fit.hidden.has(id)), `the group emptied at ${windowWidth} pt with ${["t2", "t3", "t5", "t6"].filter((id) => !fit.hidden.has(id))} still in the strip`);
    }
  }
  const lettersOnly = stripAfter(entries, noFavicons, [760]);
  assert.ok(entries[3].members.some((t) => !lettersOnly.fit.hidden.has(t.id)), `at 760 pt before favicons load the group keeps a tab: ${JSON.stringify(lettersOnly.widths)}`);
  assert.ok(Object.values(lettersOnly.widths).every((w) => w === "menu" || w >= TITLE_MIN_CHIP));
});

const readableAt = (entries, activeId, page, m, hidden) =>
  layoutStrip(withoutTabs(entries, hidden), activeId, page, withOverflowCounts(m, entries, hidden), null, { chip: TITLE_MIN_CHIP, titled: TITLE_MIN_CHIP, selected: SELECTED_STEPS.at(-1) }).tabsEnd + GAP + NEW_TAB_ROOM <= page + 0.5;

test("seven letter-icon tabs that all fit at a readable 80 pt stay in a 720 pt strip, with no favicon tab among them", () => {
  const tabs = Array.from({ length: 7 }, (_, i) => tab(`t${i}`));
  const m = measured(tabs.map((t) => t.id));
  assert.ok(readableAt(tabs, "t0", 720, m, new Set()));
  const fit = stripOverflow(tabs, "t0", 720, m, null);
  assert.deepEqual([...fit.hidden], []);
  const strip = layoutStrip(tabs, "t0", 720, m, null, undefined, "t0", fit.selectedMin, fit.titledMin, fit.compactMin);
  assert.ok(tabs.every((t) => strip.tabWidth(t.id) >= TITLE_MIN_CHIP), JSON.stringify(tabs.map((t) => strip.tabWidth(t.id))));
});

test("after tabs move into the open tabs menu, favicon tabs left in a 442 pt strip keep their titles when the rest fit at 80 pt", () => {
  const tabs = Array.from({ length: 8 }, (_, i) => tab(`t${i}`));
  const m = measured(tabs.slice(3).map((t) => t.id));
  const fit = stripOverflow(tabs, "t0", 442, m, null);
  assert.ok(fit.hidden.size > 0);
  const strip = layoutStrip(withoutTabs(tabs, fit.hidden), "t0", 442, withOverflowCounts(m, tabs, fit.hidden), null, undefined, "t0", fit.selectedMin, fit.titledMin, fit.compactMin);
  assert.ok(["t1", "t2"].every((id) => strip.tabWidth(id) >= TITLE_MIN_CHIP), `t1 ${strip.tabWidth("t1")} pt, t2 ${strip.tabWidth("t2")} pt`);
  assert.ok(strip.tabsEnd + GAP + NEW_TAB_ROOM <= 442.5);
});

test("across strips of favicon and letter-icon tabs, nothing moves into the menu while every tab fits at 80 pt, and no tab shows only its icon while the tabs left fit at 80 pt", () => {
  for (const n of [4, 7, 8, 12, 20]) {
    for (const favicons of [0, 1, 3, n - 1]) {
      const tabs = Array.from({ length: n }, (_, i) => tab(`t${i}`));
      const m = measured(tabs.slice(favicons).map((t) => t.id));
      for (let page = 300; page <= 1600; page += 7) {
        const fit = stripOverflow(tabs, "t0", page, m, null);
        const where = `${n} tabs, ${favicons} favicons, ${page} pt`;
        if (fit.hidden.size) assert.ok(!readableAt(tabs, "t0", page, m, new Set()), `${where}: ${[...fit.hidden]} moved into the menu though every tab fits at 80 pt`);
        const strip = layoutStrip(withoutTabs(tabs, fit.hidden), "t0", page, withOverflowCounts(m, tabs, fit.hidden), null, undefined, "t0", fit.selectedMin, fit.titledMin, fit.compactMin);
        const iconOnly = tabs.filter((t) => !fit.hidden.has(t.id) && t.id !== "t0" && strip.tabWidth(t.id) < TITLE_MIN_CHIP);
        if (iconOnly.length) assert.ok(!readableAt(tabs, "t0", page, m, fit.hidden), `${where}: ${iconOnly.map((t) => t.id)} show only an icon though the tabs left fit at 80 pt`);
      }
    }
  }
});

test("closing the last tab while the pointer stays widens the new last tab into the freed room, so its × is under the pointer and the left edge stays put", () => {
  const before = layoutStrip(["a", "b", "c", "d"].map(tab), "d", 1000, measured(), null);
  const end = before.spanOf("d")[0] + before.spanOf("d")[1];
  const closed = ["a", "b", "c"].map(tab);
  const plain = layoutStrip(closed, "c", 1000, measured(), null, before.widths);
  const freed = end - (plain.spanOf("c")[0] + plain.spanOf("c")[1]);
  assert.equal(freed, before.tabWidth("d") + GAP);
  const held = layoutStrip(closed, "c", 1000, measured(), null, before.widths, "c", undefined, undefined, undefined, { tabId: "c", by: freed });
  assert.deepEqual(held.spanOf("a"), before.spanOf("a"));
  assert.deepEqual(held.spanOf("b"), before.spanOf("b"));
  assert.equal(held.spanOf("c")[0] + held.spanOf("c")[1], end);
  assert.equal(held.tabsEnd, before.tabsEnd);
});

test("closing a middle tab and then the last one at the same spot widens the new last tab only to the closed tab's edge, so its × stays under the pointer", () => {
  const before = layoutStrip(["a", "b", "c", "d"].map(tab), "d", 1000, measured(), null);
  const edge = (l, id) => l.spanOf(id)[0] + l.spanOf(id)[1];
  const pointer = edge(before, "c");
  const closedC = layoutStrip(["a", "b", "d"].map(tab), "d", 1000, measured(), null, before.widths);
  assert.equal(edge(closedC, "d"), pointer);
  const closed = ["a", "b"].map(tab);
  const plain = layoutStrip(closed, "b", 1000, measured(), null, before.widths);
  const held = layoutStrip(closed, "b", 1000, measured(), null, before.widths, "b", undefined, undefined, undefined, { tabId: "b", by: edge(closedC, "d") - edge(plain, "b") });
  assert.equal(edge(held, "b"), pointer);
  assert.deepEqual(held.spanOf("a"), before.spanOf("a"));
  const closedB = layoutStrip(["a"].map(tab), "a", 1000, measured(), null, before.widths, "a", undefined, undefined, undefined, { tabId: "a", by: edge(held, "b") - edge(layoutStrip(["a"].map(tab), "a", 1000, measured(), null, before.widths), "a") });
  assert.equal(edge(closedB, "a"), pointer);
});

test("after the last tab closes and widens its neighbour, closing a middle tab lets the next tab slide into its place at the held width", () => {
  const before = layoutStrip(["a", "b", "c", "d"].map(tab), "d", 1000, measured(), null);
  const edge = (l, id) => l.spanOf(id)[0] + l.spanOf(id)[1];
  const afterB = layoutStrip(["a", "c"].map(tab), "c", 1000, measured(), null, before.widths);
  assert.equal(edge(afterB, "c"), edge(before, "b"));
  assert.deepEqual(afterB.spanOf("a"), before.spanOf("a"));
});
