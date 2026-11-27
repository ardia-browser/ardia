import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { sidebarEntries, numberedTabs, groupEntries } = await import("../sidebar/entries.ts");
const { inOrderTabIds } = await import("../tabs/switchOrder.ts");
const { openFromPage } = await import("../tabs/openFromPage.ts");
const { setPinnedCollapsed, shownPinnedEntries } = await import("../sidebar/pinnedFold.ts");
const { withLiveFolders, anchorKey } = await import("../sidebar/pinnedOrder.ts");
const { clearedTabIds } = await import("./clearedTabs.ts");
const { pinnedAreaKeys } = await import("./pinnedArea.ts");
const { parkWindowPins } = await import("./parkedPins.ts");
const { takePinChildCounts } = await import("../telemetry/pinChildCounts.ts");
const { sessionWithPinChildMarkers } = await import("./pinChildren.ts");
const { SESSION_VERSION, loadSession } = await import("../session/persist.ts");
const { versionedJson } = await import("../../lib/savedDocument.ts");
const { savedDocumentValue } = await import("../session/documentJson.ts");
const { SESSION_DOCUMENT } = await import("../session/sessionDocument.ts");
const { aimAt } = await import("../../components/sidebar/dragZones.ts");
const stub = await import("../../test-native/index.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

setConsentPeriod(true, "pin-children");

let clock = Date.now();
Date.now = () => (clock += 1000);
const S = () => useBrowser.getState();
const host = (id) => S().tabs[id]?.url.replace(/^https:\/\/|\.com\/?$/g, "");
const tabsOf = (entries) => entries.map((e) => (e.startsWith("t:") ? host(e.slice(2)) : e.startsWith("g:") ? `[${S().groups[e.slice(2)].name}]` : e));
const pinned = (w) => tabsOf(sidebarEntries(S(), w).pinned);
const list = (w) => tabsOf(sidebarEntries(S(), w).list);

function reset(settings = {}) {
  S().hydrate({});
  S().updateSettings({ newTabPosition: "bottom", ...settings });
  takePinChildCounts();
}

function windowWith(...names) {
  const w = S().createWindow({ url: `https://${names[0]}.com/` });
  const ids = [S().windows[w].tabIds[0], ...names.slice(1).map((n) => S().newTab(w, { url: `https://${n}.com/` }))];
  return [w, ...ids];
}

const ref = (w, tabId) => ({ windowId: w, profileId: S().windows[w].profileId, tabId });
const link = (w, from, name, disposition = "background", extra = {}) => {
  openFromPage({ url: `https://${name}.com/`, disposition, ...extra }, ref(w, from));
  return Object.keys(S().tabs).find((id) => S().tabs[id].url === `https://${name}.com/`);
};

function pinnedRowWithLinks(settings = {}) {
  reset(settings);
  const [w, p, q, a] = windowWith("p", "q", "a");
  S().pinTabs([p, q], true, true);
  S().activate(p);
  return { w, p, q, a };
}

for (const cmdClickCreatesTabGroup of [false, true]) {
  test(`links from a pinned row nest under it in the order opened, behind or in front (⌘-click groups ${cmdClickCreatesTabGroup ? "on" : "off"})`, () => {
    const { w, p } = pinnedRowWithLinks({ cmdClickCreatesTabGroup });
    const c1 = link(w, p, "c1");
    const c2 = link(w, p, "c2", "foreground");
    S().activate(p);
    const c3 = link(w, p, "c3");
    assert.deepEqual(pinned(w), ["p", "c1", "c2", "c3", "q"]);
    assert.deepEqual(list(w), ["a"]);
    for (const c of [c1, c2, c3]) {
      assert.equal(S().tabs[c].pin, null, "a temporary row, not a pin");
      assert.equal(S().tabs[c].pinChildOf, p);
    }
    assert.deepEqual(Object.keys(S().groups), [], "no tab group, whatever the setting");
    assert.equal(takePinChildCounts().pin_children_opened, 3);
  });
}

test("a link from a Top App tile, a pop-up, or a tab opened from a pinned row some other way goes to the top of the list", () => {
  reset();
  const [w, t, p, a] = windowWith("t", "p", "a");
  S().pinTabs([t], true);
  S().pinTabs([p], true, true);
  const fromTile = link(w, t, "fromtile");
  const popup = link(w, p, "popup", "foreground", { popup: true });
  S().newTab(w, { url: "https://typed.com/", openerId: p, background: true });
  assert.deepEqual(pinned(w), ["p"]);
  assert.deepEqual(list(w).slice(0, 3).sort(), ["fromtile", "popup", "typed"]);
  assert.ok(list(w).includes("a"));
  assert.equal(S().tabs[fromTile].pinChildOf, undefined);
  assert.equal(S().tabs[popup].pinChildOf, undefined);
});

test("⌘1–9, Ctrl-Tab and Shift-click selection follow the rows as shown", () => {
  const { w, p, q, a } = pinnedRowWithLinks();
  const c1 = link(w, p, "c1");
  const c2 = link(w, p, "c2");
  assert.deepEqual(numberedTabs(S(), w), [p, c1, c2, q, a]);
  for (const id of [c1, c2, q]) S().activate(id);
  S().activate(p);
  assert.deepEqual(inOrderTabIds(S(), w), [p, c1, c2, q, a]);
  S().cycle(w, 1);
  assert.equal(S().windows[w].activeTabIds.default, c1, "the next tab is the link under the pinned row");
  S().clickTab(w, q, { shiftKey: true });
  assert.deepEqual(S().selection[w], [c1, c2, q]);
});

test("⌘W closes a nested link for good; closing the pinned row keeps its links", () => {
  const { w, p, a } = pinnedRowWithLinks();
  const c1 = link(w, p, "c1");
  const c2 = link(w, p, "c2");
  S().activate(c1);
  S().closeTab(c1);
  assert.equal(S().tabs[c1], undefined);
  assert.ok(!S().closedTabs.some((c) => c.tab.pin), "it goes to Recently Closed as a tab, not a pin");
  S().activate(p);
  S().closeTab(p);
  assert.ok(S().tabs[p].pin, "the pinned row is reset, not removed");
  assert.deepEqual(pinned(w), ["p", "c2", "q"]);
  assert.ok(list(w).includes(host(a)));
});

test("unpinning the opener or removing it sends its links to the top of the list as normal tabs", () => {
  const { w, p, q } = pinnedRowWithLinks();
  const c1 = link(w, p, "c1");
  S().pinTabs([p], false);
  assert.deepEqual(list(w), ["p", "c1", "a"]);
  assert.equal(S().tabs[c1].pinChildOf, undefined);
  S().activate(q);
  const c2 = link(w, q, "c2");
  S().activate(c2);
  S().closeTab(q);
  S().removeClosedPin(q);
  assert.equal(S().tabs[q], undefined, "the closed pinned row was removed");
  assert.deepEqual(pinned(w), []);
  assert.equal(list(w)[0], "c2");
  assert.equal(S().tabs[c2].pinChildOf, undefined);
});

test("a pinned row moved into a pinned folder and back out keeps its links under it", () => {
  const { w, p, q, a } = pinnedRowWithLinks();
  const c1 = link(w, p, "c1");
  const folder = S().groupTabs([p, q], { pinned: true, name: "F" });
  assert.deepEqual(pinned(w), ["[F]"]);
  assert.deepEqual(tabsOf(groupEntries(S(), folder)), ["p", "c1", "q"]);
  assert.deepEqual(numberedTabs(S(), w), [p, c1, q, a]);
  const c2 = link(w, q, "c2");
  assert.deepEqual(tabsOf(groupEntries(S(), folder)), ["p", "c1", "q", "c2"], "a folder member's links nest under it too");
  S().placeTabs([p], { pinned: true, row: true });
  assert.deepEqual(pinned(w), ["p", "c1", "[F]"]);
  assert.equal(S().tabs[c2].pinChildOf, q);
  assert.equal(S().tabs[c1].pinChildOf, p);
});

test("dragging a link to the list makes it a normal tab; into Pinned or ⌘D pins it", () => {
  const { w, p, a } = pinnedRowWithLinks();
  const c1 = link(w, p, "c1");
  const c2 = link(w, p, "c2");
  const c3 = link(w, p, "c3");
  S().dropTabs([c1], { type: "tabs", placement: { pinned: false, beforeId: a } });
  assert.equal(S().tabs[c1].pinChildOf, undefined);
  assert.deepEqual(list(w), ["c1", "a"]);
  S().placeTabs([c2], { pinned: true, row: true, last: true });
  assert.deepEqual(S().tabs[c2].pin, { as: "row" });
  assert.equal(S().tabs[c2].pinChildOf, undefined);
  S().togglePin(c3);
  assert.ok(S().tabs[c3].pin);
  assert.equal(S().tabs[c3].pinChildOf, undefined);
  assert.deepEqual(pinned(w), ["p", "q", "c2"]);
  assert.deepEqual(takePinChildCounts(), { pin_children_opened: 3, pin_children_pinned: 2, pin_children_moved_out: 1 });
});

test("keyboard moves step a link among its siblings only", () => {
  const { w, p } = pinnedRowWithLinks();
  const c1 = link(w, p, "c1");
  const c2 = link(w, p, "c2");
  S().moveTabBy(c2, -1);
  assert.deepEqual(pinned(w), ["p", "c2", "c1", "q"]);
  S().moveTabBy(c2, -1);
  assert.deepEqual(pinned(w), ["p", "c2", "c1", "q"], "the first link stays under its opener");
  S().moveTabBy(c1, 1);
  assert.deepEqual(pinned(w), ["p", "c2", "c1", "q"], "the last link stays above the next pinned row");
  assert.equal(S().tabs[c1].pinChildOf, p);
});

test("a dragged link dropped back under its opener does nothing; other rows never land between a row and its links", () => {
  const frame = (y) => ({ x: 0, y, w: 200, h: 30 });
  const item = (key, tabIds, y, nestedUnder) => ({ key, kind: "row", tabIds, section: "pinnedRows", nestedUnder, frame: frame(y), headerFrame: null });
  const opener = item("t:p", ["p"], 0);
  const c1 = item("t:c1", ["c1"], 30, "p");
  const c2 = item("t:c2", ["c2"], 60, "p");
  const q = item("t:q", ["q"], 90);
  const pointing = (source, blocks, y) => ({
    x: 50, y, source, live: blocks, blocks, moved: [source.key], tabsDrag: true, external: false, away: false, inPanel: false, held: null, overTiles: false, tiles: null, spot: null, cells: [], count: 1, balanced: false, grid: false, inPinned: true,
    kept: { gapKey: null, pitch: 30 }, shown: (i) => i.frame, at: (f) => f, splits: false, splitTarget: () => null, overPinnedRows: () => true, leadTab: (k) => k,
    cy: (i) => i.frame.y + i.frame.h / 2, byY: (a, b) => a.frame.y - b.frame.y, firstTab: (i) => i?.tabIds[0] ?? null,
  });
  for (const y of [32, 62, 88]) assert.equal(aimAt(pointing(c1, [opener, c2, q], y)).spot, null, `a drop at ${y} is a no-op`);
  assert.deepEqual(aimAt(pointing(c1, [opener, c2, q], 120)).spot, { zone: "pinnedRows", beforeId: null });
  const row = item("t:r", ["r"], 200);
  assert.deepEqual(aimAt(pointing(row, [opener, c1, c2, q], 32)).spot, { zone: "pinnedRows", beforeId: "q" });
});

test("the pinned page handed to another window keeps its links under it", () => {
  reset();
  const [a, mail, other] = windowWith("mail", "other");
  S().pinTabs([mail], true, true);
  S().activate(mail);
  const child = link(a, mail, "child");
  const b = S().createWindow({ url: "https://b.com/" });
  const copy = S().windows[b].tabIds.find((id) => S().tabs[id].pinnedUrl === "https://mail.com/");
  assert.ok(copy, "the pinned row shows in the other window too");
  S().activate(copy);
  assert.equal(S().tabs[mail].windowId, b);
  assert.equal(S().tabs[child].pinChildOf, copy, "the link follows the row that stays in its window");
  assert.deepEqual(pinned(a), ["mail", "child"]);
  assert.ok(S().tabs[other]);
});

test("pinned sync and parked pins never see the links", () => {
  const { w, p } = pinnedRowWithLinks();
  const c1 = link(w, p, "c1");
  assert.ok(!pinnedAreaKeys(S(), S().windows[w], "default").some((k) => k.includes(c1)));
  const parked = parkWindowPins({}, S().windows[w], S());
  assert.ok(!parked.default.tabs.some((t) => t.url === "https://c1.com/"));
  assert.equal(parked.default.tabs.length, 2);
});

test("Clear leaves the links under pinned rows alone", () => {
  const { w, p, a } = pinnedRowWithLinks();
  const c1 = link(w, p, "c1");
  assert.deepEqual(clearedTabIds(S(), w), [a]);
  assert.ok(!clearedTabIds(S(), w).includes(c1));
});

test("collapsed Pinned shows only the link in front, and a live folder after the opener comes after its links", () => {
  const { w, p } = pinnedRowWithLinks();
  const c1 = link(w, p, "c1");
  link(w, p, "c2");
  S().activate(c1);
  setPinnedCollapsed("default", true);
  assert.deepEqual(shownPinnedEntries(S(), w, "default", sidebarEntries(S(), w).pinned), [`t:${c1}`]);
  setPinnedCollapsed("default", false);
  const entries = sidebarEntries(S(), w).pinned;
  const keys = entries.map((e) => anchorKey(S(), e));
  assert.deepEqual(tabsOf(withLiveFolders(entries, keys, [{ id: "lf", after: keys[0] }])), ["p", "c1", "c2", "lf:lf", "q"]);
});

test("a Peek from a pinned row turned into a tab nests under it", () => {
  const { w, p } = pinnedRowWithLinks();
  const peek = S().openPeek(p, "https://peeked.com/");
  S().peekToTab(w);
  assert.equal(S().tabs[peek].pinChildOf, p);
  assert.deepEqual(pinned(w), ["p", "peeked", "q"]);
});

test("the session keeps a link under its row, and an old pinned tab's link group becomes nested links", () => {
  stub.docs.clear();
  const { w, p } = pinnedRowWithLinks();
  const c1 = link(w, p, "c1");
  stub.docs.set("session.json", versionedJson(savedDocumentValue(SESSION_DOCUMENT, S()), SESSION_VERSION));
  assert.match(stub.docs.get("session.json"), /"pinChildOf"/);
  S().hydrate(loadSession());
  assert.equal(S().tabs[c1].pinChildOf, p);
  assert.deepEqual(pinned(w), ["p", "c1", "q"]);

  assert.equal(SESSION_VERSION, 11, "no new session version, so an older build still opens what this one saves");
  const legacy = {
    tabs: [{ id: "pin", pin: { as: "row" } }, { id: "k1" }, { id: "k2" }, { id: "x" }, { id: "y" }],
    groups: [
      { id: "g1", windowId: "w", profileId: "default", tabIds: ["k1", "k2"], autoUngroup: true, pinnedOpenerId: "pin" },
      { id: "g2", windowId: "w", profileId: "default", tabIds: ["x"] },
      { id: "g3", windowId: "w", profileId: "default", tabIds: ["y"], pinned: true, pinnedOpenerId: "pin" },
    ],
    parkedPins: { default: { tabs: [], groups: [{ id: "g4", pinned: true, pinnedOpenerId: "pin" }] } },
  };
  const once = sessionWithPinChildMarkers(structuredClone(legacy));
  assert.deepEqual(sessionWithPinChildMarkers(once), once, "a second run changes nothing");
  assert.deepEqual(once.groups.map((g) => g.id), ["g2", "g3"], "a group the user pinned stays a folder");
  assert.ok(once.groups.every((g) => !("pinnedOpenerId" in g)) && !("pinnedOpenerId" in once.parkedPins.default.groups[0]));
  assert.deepEqual(once.tabs.map((t) => t.pinChildOf), [undefined, "pin", "pin", undefined, undefined]);

  const tab = (id, extra = {}) => ({ id, windowId: "w1", profileId: "default", url: `https://${id}.com/`, title: id, favicon: null, pin: null, muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: null, openerId: null, page: { kind: "idle" }, createdAt: 0, lastActiveAt: 0, ...extra });
  stub.docs.set("session.json", JSON.stringify({
    version: 11,
    profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } },
    profileOrder: ["default"],
    windows: [{ id: "w1", profileId: "default", tabIds: ["row", "y", "k1", "k2", "x"], activeTabIds: { default: "row" }, frame: null, createdAt: 0 }],
    windowOrder: ["w1"],
    tabs: [tab("row", { pin: { as: "row" }, pinnedUrl: "https://row.com/" }), tab("y"), tab("k1"), tab("k2"), tab("x")],
    groups: [
      { id: "g1", windowId: "w1", profileId: "default", name: "", icon: null, color: null, collapsed: false, pinned: false, tabIds: ["k1", "k2"], createdAt: 0, autoUngroup: true, pinnedOpenerId: "row" },
      { id: "g3", windowId: "w1", profileId: "default", name: "Kept", icon: null, color: null, collapsed: false, pinned: true, tabIds: ["y"], createdAt: 0, autoUngroup: true, pinnedOpenerId: "row" },
    ],
    splits: [],
  }));
  S().hydrate(loadSession());
  assert.deepEqual(pinned("w1"), ["row", "k1", "k2", "[Kept]"]);
  assert.deepEqual(list("w1"), ["x"]);
  assert.deepEqual(Object.keys(S().groups), ["g3"], "the folder made from an opener group with Pin Group stays");
  assert.equal(S().groups.g3.pinned, true);
  assert.equal("pinnedOpenerId" in S().groups.g3, false);
  assert.equal(S().tabs.y.pinChildOf, undefined, "its tab stays a pinned-folder tab that ⌘W only unloads");
  assert.deepEqual([...stub.docs.keys()].filter((k) => k.includes("unreadable")), [], "converting old groups never counts as rows lost");
});

test("with tabs on top, ⌘1–9 and Shift-click follow the strip, where links sit after the pinned tabs", () => {
  const { w, p, q, a } = pinnedRowWithLinks({ tabLayout: "top" });
  const c1 = link(w, p, "c1");
  const c2 = link(w, p, "c2");
  assert.deepEqual(numberedTabs(S(), w), [p, q, c1, c2, a]);
  S().activate(p);
  S().clickTab(w, q, { shiftKey: true });
  assert.deepEqual(S().selection[w], [p, q], "the range stops at the pinned tab clicked");
  S().updateSettings({ tabLayout: "sidebar" });
  assert.deepEqual(numberedTabs(S(), w), [p, c1, c2, q, a], "back in the sidebar they nest again");
});

test("New Group, Add to Group and a split end the link's place under its opener, like a drag does", () => {
  const { w, p, a } = pinnedRowWithLinks();
  const c1 = link(w, p, "c1");
  const c2 = link(w, p, "c2");
  const c3 = link(w, p, "c3");
  takePinChildCounts();
  const g = S().groupTabs([c1, a], { pinned: false });
  assert.equal(S().tabs[c1].pinChildOf, undefined);
  S().ungroup(g);
  assert.ok(list(w).includes("c1") && !pinned(w).includes("c1"), "ungrouped, it stays in the list");
  const g2 = S().createGroup([a]);
  S().addTabsToGroup(g2, [c2]);
  assert.equal(S().tabs[c2].pinChildOf, undefined);
  assert.deepEqual(takePinChildCounts().pin_children_moved_out, 2);
  if (S().createSplit([c3, a])) assert.equal(S().tabs[c3].pinChildOf, undefined);
});
