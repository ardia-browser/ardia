import assert from "node:assert/strict";
import { test } from "node:test";
const { heldWideTab, keyedWidths, layoutStrip, nameGrowth, namesStayTight, withRoomyNames, stripFit, stripTabWidths, underPressure } = await import("./stripGroups.ts");
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

const fitsPage = (strip, page) => strip.tabsEnd + GAP + NEW_TAB_ROOM <= page + 0.5;
const laidOut = (entries, activeId, page, m) => {
  const fit = stripFit(entries, activeId, page, m, null);
  return { fit, strip: layoutStrip(entries, activeId, page, m, null, undefined, activeId, fit.selectedMin, fit.titledMin, fit.compactMin) };
};

test("tabs that can't keep a readable title stay in the strip at the titled width, and the strip scrolls instead of hiding any", () => {
  const tabs = Array.from({ length: 12 }, (_, i) => tab(`t${i}`));
  const needs = tabs.map((t) => t.id);
  const { fit, strip } = laidOut(tabs, "t3", 900, measured(needs));
  assert.deepEqual(fit, { selectedMin: SELECTED_TIGHT_CHIP, titledMin: TITLED_CHIP, compactMin: COMPACT_CHIP });
  assert.equal(strip.top.slots.length, 12);
  assert.equal(strip.tabWidth("t3"), SELECTED_TIGHT_CHIP);
  for (const t of tabs) if (t.id !== "t3") assert.equal(strip.tabWidth(t.id), TITLED_CHIP);
  assert.ok(!fitsPage(strip, 900));
  assert.deepEqual(strip.spanOf("t11"), [11 * (TITLED_CHIP + GAP) - TITLED_CHIP + SELECTED_TIGHT_CHIP, TITLED_CHIP]);
  const favicons = laidOut(tabs, "t3", 900, measured([]));
  assert.ok(fitsPage(favicons.strip, 900), "twelve favicon tabs fit as icons and don't scroll");
});

test("five hundred tabs all stay in the strip: favicon tabs as icons, the rest at the titled width, the selected tab at its tight width", () => {
  const tabs = Array.from({ length: 500 }, (_, i) => tab(`t${i}`));
  const needs = tabs.filter((_, i) => i % 3 === 0).map((t) => t.id);
  const { strip } = laidOut(tabs, "t250", 1100, measured(needs));
  assert.equal(strip.top.slots.length, 500);
  const titled = needs.filter((id) => id !== "t250").length;
  const compact = 499 - titled;
  assert.equal(strip.tabsEnd, titled * TITLED_CHIP + compact * COMPACT_CHIP + SELECTED_TIGHT_CHIP + 499 * GAP);
  assert.equal(strip.tabWidth("t1"), COMPACT_CHIP);
  assert.equal(strip.tabWidth("t3"), TITLED_CHIP);
});

test("the selected tab gives back its extra width before the strip scrolls, and keeps it when the window can afford it", () => {
  const tabs = Array.from({ length: 7 }, (_, i) => tab(`t${i}`));
  const needs = tabs.map((t) => t.id);
  const roomy = stripFit(tabs, "t0", 1400, measured(needs), null);
  assert.equal(roomy.selectedMin, SELECTED_MIN_CHIP);
  const atMin = (page) => layoutStrip(tabs, "t0", page, measured(needs), null, undefined, "t0", SELECTED_MIN_CHIP);
  const page = Math.ceil(atMin(2000).tabsEnd - (MAX_CHIP - TITLED_CHIP) * 6 + GAP + NEW_TAB_ROOM) - 20;
  const tight = stripFit(tabs, "t0", page, measured(needs), null);
  assert.ok(tight.selectedMin < SELECTED_MIN_CHIP && tight.selectedMin >= SELECTED_TIGHT_CHIP);
  const strip = layoutStrip(tabs, "t0", page, measured(needs), null, undefined, "t0", tight.selectedMin);
  assert.ok(strip.tabsEnd + GAP + NEW_TAB_ROOM <= page + 0.5);
  assert.ok(strip.selected < MAX_CHIP);
});

test("the strip is under pressure while the selected tab or a titled tab gives back width", () => {
  assert.equal(underPressure({ selectedMin: SELECTED_MIN_CHIP, titledMin: TITLED_CHIP }), false);
  assert.equal(underPressure({ selectedMin: SELECTED_TIGHT_CHIP, titledMin: TITLED_CHIP }), true);
  assert.equal(underPressure({ selectedMin: SELECTED_MIN_CHIP, titledMin: TITLE_MIN_CHIP }), true);
});

function fitOneByOne(entries, activeId, pageWidth, measured, wideId = activeId) {
  const layout = (selectedMin, titledMin, compactMin) => layoutStrip(entries, activeId, pageWidth, measured, null, undefined, wideId, selectedMin, titledMin, compactMin);
  const fits = (selectedMin) => fitsPage(layout(selectedMin), pageWidth);
  const tight = SELECTED_STEPS.at(-1);
  const readable = (selectedMin, titledMin) => fitsPage(layout(selectedMin, titledMin, TITLE_MIN_CHIP), pageWidth);
  const favicons = layout(tight).compactShown > 0;
  if (favicons) {
    const step = SELECTED_STEPS.find((s) => readable(s, TITLED_CHIP));
    if (step !== undefined) return { selectedMin: step, titledMin: TITLED_CHIP, compactMin: TITLE_MIN_CHIP };
    if (readable(tight, TITLE_MIN_CHIP)) return { selectedMin: tight, titledMin: TITLE_MIN_CHIP, compactMin: TITLE_MIN_CHIP };
  }
  const roomy = SELECTED_STEPS.find((step) => fits(step));
  if (roomy !== undefined) return { selectedMin: roomy, titledMin: TITLED_CHIP, compactMin: COMPACT_CHIP };
  if (!favicons && readable(tight, TITLE_MIN_CHIP)) return { selectedMin: tight, titledMin: TITLE_MIN_CHIP, compactMin: TITLE_MIN_CHIP };
  return { selectedMin: tight, titledMin: TITLED_CHIP, compactMin: COMPACT_CHIP };
}

test("the fit picks exactly what laying the strip out at each stage would, across random strips", () => {
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
    assert.deepEqual(stripFit(entries, activeId, pageWidth, measured, null), fitOneByOne(entries, activeId, pageWidth, measured), `run ${run} at ${pageWidth} pt`);
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

test("a thousand titled tabs at 600 pt fit for about one layout's work, counted in calls into the strip's measures", () => {
  const tabs = Array.from({ length: 1000 }, (_, i) => tab(`t${i}`));
  const m = measured(tabs.map((t) => t.id));
  const layout = callsOf(m, (c) => layoutStrip(tabs, "t500", 600, c, null));
  const fit = callsOf(m, (c) => stripFit(tabs, "t500", 600, c, null));
  assert.ok(layout <= 2 * tabs.length, `one layout made ${layout} calls for ${tabs.length} tabs`);
  assert.ok(fit <= 2 * layout, `the fit made ${fit} calls against ${layout} for one layout`);
});

test("strips with a thousand groups fit for about one layout's work, chip widths found by key", () => {
  const entries = Array.from({ length: 1000 }, (_, g) => ({ kind: "group", id: `g${g}`, collapsed: g % 3 === 0, members: [tab(`g${g}a`), tab(`g${g}b`), tab(`g${g}c`)] }));
  const ids = new Set(entries.flatMap((e) => e.members.map((m) => m.id)));
  const groupIds = entries.map((e) => e.id);
  const widths = groupIds.map((_, i) => 70 + (i % 40));
  assert.equal(keyedWidths(groupIds, widths)("g41"), 71);
  assert.equal(keyedWidths(groupIds, widths)("missing"), undefined);
  const keyed = { groupChip: keyedWidths(groupIds, widths), folderChip: keyedWidths([], []), needsTitle: (id) => ids.has(id) };
  const layout = callsOf(keyed, (c) => layoutStrip(entries, "g1a", 600, c, null));
  const fit = callsOf(keyed, (c) => stripFit(entries, "g1a", 600, c, null));
  assert.ok(fit <= 2 * layout, `the fit made ${fit} calls against ${layout} for one layout`);
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
    return namesStayTight(tight, stripFit(entries, "x", page, m, null), () => stripFit(entries, "x", page, withRoomyNames(m, growth), null));
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
      const fit = stripFit(entries, "t1", page, m, null);
      tight.names = namesStayTight(tight.names, fit, () => stripFit(entries, "t1", page, withRoomyNames(m, () => TRIP_NAME), null));
      const strip = layoutStrip(entries, "t1", page, m, null, undefined, "t1", fit.selectedMin, fit.titledMin, fit.compactMin);
      const ids = entries.flatMap((e) => (e.kind === "group" ? e.members.map((t) => t.id) : [e.id]));
      shown = { page, fit, strip, needs, m, widths: Object.fromEntries(ids.map((id) => [id, strip.tabWidth(id)])) };
    }
  }
  return shown;
}

test("the filmed strip at 1180 and 760 pt lays out the same whether the window opened at that width or was resized to it", () => {
  const { entries, favicons } = tripStrip();
  const noFavicons = Object.fromEntries(Object.keys(favicons).map((id) => [id, ""]));
  const result = ({ fit, widths }) => ({ ...fit, widths });
  for (const icons of [favicons, noFavicons]) {
    assert.deepEqual(result(stripAfter(entries, icons, [760])), result(stripAfter(entries, icons, [1180, 1100, 1000, 900, 800, 760])), "760 pt");
    assert.deepEqual(result(stripAfter(entries, icons, [1180])), result(stripAfter(entries, icons, [760, 900, 1050, 1180])), "1180 pt");
  }
  const tight = { names: false };
  stripAfter(entries, noFavicons, [760], tight);
  assert.deepEqual(result(stripAfter(entries, favicons, [760], tight)), result(stripAfter(entries, favicons, [1180, 760])), "favicons arriving after the window opened narrow land where narrowing with them loaded does");
  const narrow = stripAfter(entries, favicons, [760]);
  assert.ok(!fitsPage(narrow.strip, narrow.page), "at 760 pt the strip scrolls");
  assert.deepEqual(narrow.widths, { t1: SELECTED_TIGHT_CHIP, t2: COMPACT_CHIP, t3: COMPACT_CHIP, g1: COMPACT_CHIP, g2: COMPACT_CHIP, g3: TITLED_CHIP, g4: TITLED_CHIP, g5: TITLED_CHIP, t5: TITLED_CHIP, t6: TITLED_CHIP });
});

test("titled tabs in the filmed strip keep a readable width at every window width, and a tab shows only its icon only when every tab readable wouldn't fit", () => {
  const { entries, favicons } = tripStrip();
  for (let windowWidth = 700; windowWidth <= 1500; windowWidth += 10) {
    const { page, fit, strip, needs, m, widths } = stripAfter(entries, favicons, [windowWidth]);
    const shown = Object.entries(widths);
    for (const [id, w] of shown) if (needs.has(id)) assert.ok(w >= TITLE_MIN_CHIP, `${id} at ${windowWidth} pt is ${w} pt`);
    const iconOnly = shown.filter(([id, w]) => !needs.has(id) && id !== "t1" && w < TITLE_MIN_CHIP);
    if (!iconOnly.length) continue;
    const readable = { chip: TITLE_MIN_CHIP, titled: TITLE_MIN_CHIP, selected: SELECTED_STEPS.at(-1) };
    const allReadable = layoutStrip(entries, "t1", page, m, null, readable, "t1", fit.selectedMin, fit.titledMin);
    assert.ok(!fitsPage(allReadable, page), `${iconOnly.map(([id]) => id)} show only an icon at ${windowWidth} pt though every tab fits at ${TITLE_MIN_CHIP} pt`);
    if (!fitsPage(strip, page)) for (const [id, w] of shown) if (id !== "t1") assert.equal(w, needs.has(id) ? TITLED_CHIP : COMPACT_CHIP, `${id} at ${windowWidth} pt scrolls at its floor`);
  }
  const roomy = stripAfter(entries, favicons, [1280]).widths;
  assert.ok(["t2", "t3", "g1", "g2"].every((id) => roomy[id] >= TITLE_MIN_CHIP), `at 1280 pt every favicon tab shows its title: ${JSON.stringify(roomy)}`);
  const wide = stripAfter(entries, favicons, [1180]);
  assert.ok(fitsPage(wide.strip, wide.page), "at 1180 pt every tab fits without scrolling");
});

test("before favicons load, every tab of the filmed strip stays in it at a readable width, the group's tabs too", () => {
  const { entries, favicons } = tripStrip();
  const noFavicons = Object.fromEntries(Object.keys(favicons).map((id) => [id, ""]));
  for (let windowWidth = 640; windowWidth <= 1180; windowWidth += 10) {
    const { widths, strip } = stripAfter(entries, noFavicons, [windowWidth]);
    assert.equal(Object.keys(widths).length, 10);
    assert.ok(Object.values(widths).every((w) => w >= TITLE_MIN_CHIP), `${windowWidth} pt: ${JSON.stringify(widths)}`);
    assert.ok(strip.spanOf("g1") && strip.spanOf("g5"));
  }
});

const readableAt = (entries, activeId, page, m) =>
  fitsPage(layoutStrip(entries, activeId, page, m, null, { chip: TITLE_MIN_CHIP, titled: TITLE_MIN_CHIP, selected: SELECTED_STEPS.at(-1) }), page);

test("seven letter-icon tabs that all fit at a readable 80 pt stay in a 720 pt strip, with no favicon tab among them", () => {
  const tabs = Array.from({ length: 7 }, (_, i) => tab(`t${i}`));
  const m = measured(tabs.map((t) => t.id));
  assert.ok(readableAt(tabs, "t0", 720, m));
  const { strip } = laidOut(tabs, "t0", 720, m);
  assert.ok(fitsPage(strip, 720));
  assert.ok(tabs.every((t) => strip.tabWidth(t.id) >= TITLE_MIN_CHIP), JSON.stringify(tabs.map((t) => strip.tabWidth(t.id))));
});

test("eight tabs that can't all fit a 442 pt strip at 80 pt scroll with every tab in it: letter-icon tabs at 96 pt, favicon tabs as icons", () => {
  const tabs = Array.from({ length: 8 }, (_, i) => tab(`t${i}`));
  const m = measured(tabs.slice(3).map((t) => t.id));
  assert.ok(!readableAt(tabs, "t0", 442, m));
  const { strip } = laidOut(tabs, "t0", 442, m);
  assert.deepEqual(tabs.map((t) => strip.tabWidth(t.id)), [SELECTED_TIGHT_CHIP, COMPACT_CHIP, COMPACT_CHIP, ...Array(5).fill(TITLED_CHIP)]);
  assert.ok(!fitsPage(strip, 442));
});

test("across strips of favicon and letter-icon tabs, nothing scrolls while every tab fits at 80 pt, and a scrolling strip holds every tab at its floor", () => {
  for (const n of [4, 7, 8, 12, 20]) {
    for (const favicons of [0, 1, 3, n - 1]) {
      const tabs = Array.from({ length: n }, (_, i) => tab(`t${i}`));
      const m = measured(tabs.slice(favicons).map((t) => t.id));
      for (let page = 300; page <= 1600; page += 7) {
        const { strip } = laidOut(tabs, "t0", page, m);
        const where = `${n} tabs, ${favicons} favicons, ${page} pt`;
        const scrolls = !fitsPage(strip, page);
        if (scrolls) assert.ok(!readableAt(tabs, "t0", page, m), `${where}: scrolls though every tab fits at 80 pt`);
        if (scrolls) for (const t of tabs.slice(1)) assert.equal(strip.tabWidth(t.id), m.needsTitle(t.id) ? TITLED_CHIP : COMPACT_CHIP, `${where}: ${t.id} scrolls above its floor`);
        const iconOnly = tabs.filter((t) => t.id !== "t0" && strip.tabWidth(t.id) < TITLE_MIN_CHIP);
        if (iconOnly.length) assert.ok(!readableAt(tabs, "t0", page, m), `${where}: ${iconOnly.map((t) => t.id)} show only an icon though every tab fits at 80 pt`);
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
