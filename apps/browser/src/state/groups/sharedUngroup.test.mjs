import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { inPinnedContainer, pinKeyOf, viewTabIds } = await import("../browser/model.ts");
const { ASLEEP, adoptOf, adoptedPage, hasOwnOrSharedPage, hasPage, holderOfPage, loadedPage, wakeOf, withWake } = await import("../tabs/pageSession.ts");
const { pendingRestore } = await import("../tabs/adoptIds.ts");
const { familyKeyOf, navigationTo } = await import("../browser/model.ts");
const { splitTabIds } = await import("../splits/splits.ts");
const { createGroupsSlice } = await import("./groups.ts");

const S = () => useBrowser.getState();
const groupIn = (windowId, key) => Object.values(S().groups).find((g) => g.windowId === windowId && pinKeyOf(g) === key);
const rows = (windowId) => viewTabIds(S(), windowId).map((id) => S().tabs[id]);
const family = (key) => Object.values(S().tabs).filter((t) => pinKeyOf(t) === key);

function windows(shared = true, count = 2) {
  S().hydrate({});
  const a = S().createWindow({ url: "https://one.example/" });
  const one = S().windows[a].tabIds[0];
  const all = [a];
  for (let n = 1; n < count; n++) all.push(S().createWindow({ url: n === 1 ? "https://two.example/" : `https://other${n}.example/` }));
  const two = S().windows[all[1]].tabIds.find((id) => S().tabs[id].url === "https://two.example/");
  S().updateSettings({ shareTabsAcrossWindows: shared });
  if (!shared) S().newTab(all[1], { url: "https://one.example/", background: true });
  const members = ["https://one.example/", "https://two.example/"].map((url) => rows(all[1]).find((t) => t.url === url).id);
  const group = S().groupTabs(members, { pinned: true, name: "Reading" });
  return { a, b: all[1], all, one, two, group };
}

function keptPages(ids, before) {
  for (const id of ids) {
    assert.ok(S().tabs[id], `the live tab ${id} survives`);
    assert.deepEqual(S().tabs[id].page.nav, before[id], "the existing page survives without a reload");
    assert.equal(family(id).filter(hasPage).length, 1, "one loaded page per family");
  }
}

for (const origin of ["original window", "mirror window"]) {
  test(`ungrouping a shared pinned folder from its ${origin} keeps its tabs in every window`, () => {
    const { a, b, all, one, two, group } = windows(true, 3);
    const before = Object.fromEntries([one, two].map((id) => [id, S().tabs[id].page.nav]));
    const closed = S().closedTabs;
    const closedGroups = S().closedGroups;
    const key = pinKeyOf(S().groups[group]);
    S().ungroup(groupIn(origin === "original window" ? b : a, key).id);
    keptPages([one, two], before);
    for (const w of all) {
      assert.equal(groupIn(w, key), undefined, "the folder is removed in every window");
      for (const id of [one, two]) {
        const copies = rows(w).filter((t) => pinKeyOf(t) === id);
        assert.equal(copies.length, 1, "each tab remains listed once");
        assert.equal(inPinnedContainer(S(), copies[0].id), false, "its tab is now in the regular list");
      }
    }
    assert.equal(S().closedTabs, closed, "ungroup does not close tabs");
    assert.equal(S().closedGroups, closedGroups, "ungroup does not close the folder's pages");
  });
}

test("ungrouping a shared pinned root keeps nested folders rooted in every window", () => {
  const { b, all, one, two, group } = windows();
  const inner = S().groupTabs([two], { name: "Nested" });
  assert.equal(S().groups[inner].parentId, group);
  const outerKey = pinKeyOf(S().groups[group]);
  const innerKey = pinKeyOf(S().groups[inner]);
  const before = Object.fromEntries([one, two].map((id) => [id, S().tabs[id].page.nav]));
  S().ungroup(groupIn(b, outerKey).id);
  for (const w of all) {
    assert.equal(groupIn(w, outerKey), undefined);
    const child = groupIn(w, innerKey);
    assert.ok(child, "the nested folder survives");
    assert.equal(child.parentId, undefined);
    assert.equal(child.pinned, true);
    assert.deepEqual(child.tabIds.map((id) => pinKeyOf(S().tabs[id])), [two]);
    assert.equal(rows(w).filter((t) => pinKeyOf(t) === one).length, 1);
  }
  keptPages([one, two], before);
});

test("ungrouping a shared nested folder keeps its tabs inside the parent", () => {
  const { b, all, one, two, group } = windows();
  const inner = S().groupTabs([two], { name: "Nested" });
  const outerKey = pinKeyOf(S().groups[group]);
  const innerKey = pinKeyOf(S().groups[inner]);
  const before = Object.fromEntries([one, two].map((id) => [id, S().tabs[id].page.nav]));
  S().ungroup(groupIn(b, innerKey).id);
  for (const w of all) {
    assert.equal(groupIn(w, innerKey), undefined);
    const parent = groupIn(w, outerKey);
    assert.ok(parent);
    assert.equal(parent.pinned, true);
    assert.deepEqual(parent.tabIds.map((id) => pinKeyOf(S().tabs[id])), [one, two]);
  }
  keptPages([one, two], before);
});

const splitsIn = (w) => Object.values(S().splits).filter((v) => v.windowId === w);

function oneCopyInSplitWindows(all) {
  for (const w of all) {
    const own = S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === "default");
    for (const v of splitsIn(w)) {
      for (const id of splitTabIds(v)) {
        const url = S().tabs[id].url;
        assert.equal(own.filter((t) => t.url === url).length, 1, `exactly one copy of ${url} in the split window`);
      }
    }
  }
}

function splitFolder(home) {
  const fixture = windows(true, 3);
  S().setFocusedWindow(fixture.b);
  S().createSplit(S().groups[fixture.group].tabIds);
  const split = splitsIn(fixture.b)[0];
  assert.ok(split);
  assert.equal(Object.values(S().splits).length, fixture.all.length, "a pinned split is mirrored in every window");
  const key = pinKeyOf(S().groups[fixture.group]);
  const before = Object.fromEntries([fixture.one, fixture.two].map((id) => [id, S().tabs[id].page.nav]));
  const to = home === "original window" ? fixture.b : fixture.a;
  S().setFocusedWindow(to);
  S().ungroup(groupIn(to, key).id);
  return { ...fixture, to, split, before };
}

for (const home of ["original window", "mirror window"]) {
  test(`ungrouping a shared folder from its ${home} keeps its split there, once, with its live pages`, () => {
    const { all, one, two, to, split, before } = splitFolder(home);
    const kept = Object.values(S().splits);
    assert.equal(kept.length, 1, "a regular split lives in one window");
    assert.equal(kept[0].windowId, to, "the window it was ungrouped from");
    assert.equal(kept[0].orientation, split.orientation);
    assert.deepEqual(splitTabIds(kept[0]).map((id) => pinKeyOf(S().tabs[id])), [one, two]);
    for (const w of all) for (const id of [one, two]) assert.equal(rows(w).filter((t) => pinKeyOf(t) === id).length, w === to ? 1 : 0, "the split's tabs live in its window only, once");
    for (const id of [one, two]) {
      assert.ok(S().tabs[id], "the tab survives");
      assert.deepEqual(S().tabs[id].page.nav, before[id], "with its page, without a reload");
    }
    assert.equal(Object.values(S().groups).filter((g) => g.pinned).length, 0, "no folder is left in any window");
  });
}

const site = (name) => `https://${name}.example/`;
const listed = (w, name) => S().windows[w].tabIds.filter((id) => S().tabs[id].url === site(name) && S().tabs[id].profileId === "default");
const folderOf = (w, group) => Object.values(S().groups).find((g) => g.windowId === w && g.pinned && pinKeyOf(g) === pinKeyOf(S().groups[group]));

function splitOnlyFolder(extra) {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("two") });
  if (extra) S().newTab(b, { url: site(extra), background: true });
  const group = S().groupTabs([listed(b, "one")[0], listed(b, "two")[0]], { pinned: true });
  S().setFocusedWindow(b);
  S().createSplit(S().groups[group].tabIds);
  assert.equal(splitsIn(a).length, 1, "the pinned split is mirrored");
  return { a, b, group };
}

test("ungrouping a split folder keeps open a window that held only its mirrored panes", () => {
  const { a, b, group } = splitOnlyFolder();
  S().ungroup(folderOf(b, group).id);
  assert.ok(S().windows[a], "the other window stays open");
  assert.ok(S().windowOrder.includes(a));
  assert.equal(splitsIn(a).length, 0, "without a second split");
  assert.ok(rows(a).length >= 1 && rows(a).every((t) => t.url !== site("one") && t.url !== site("two")), "showing a new tab instead of copies of the split's tabs");
  assert.equal(splitsIn(b).length, 1, "the split stays where it was ungrouped");
});

test("ungrouping a split folder keeps another page that a pane in the other window has open", () => {
  const { a, b, group } = splitOnlyFolder("keep");
  const away = S().tabs[splitTabIds(splitsIn(a)[0]).find((id) => S().tabs[id].url === site("one"))];
  const home = S().tabs[splitTabIds(splitsIn(b)[0]).find((id) => S().tabs[id].url === site("one"))];
  const later = `${site("one")}later`;
  useBrowser.setState((st) => ({
    tabs: {
      ...st.tabs,
      [home.id]: { ...home, page: { kind: "loaded", nav: { url: home.url, seq: 3, userInitiated: true } } },
      [away.id]: { ...away, url: later, page: { kind: "loaded", nav: { url: later, seq: 9, userInitiated: true } } },
    },
  }));
  const closed = S().closedTabs.length;
  S().ungroup(folderOf(b, group).id);
  assert.ok(hasPage(S().tabs[home.id]), "the pane in the split keeps its page");
  assert.ok(S().tabs[away.id] && hasPage(S().tabs[away.id]), "the other window's page stays open");
  assert.equal(S().tabs[away.id].url, later, "at its own address");
  assert.notEqual(pinKeyOf(S().tabs[away.id]), pinKeyOf(S().tabs[home.id]), "as a tab of its own");
  assert.equal(S().closedTabs.length, closed, "nothing goes to Recently Closed");
  assert.equal(splitsIn(a).length, 0);
  assert.equal(splitsIn(b).length, 1);
});
const pageAs = (id, page) => useBrowser.setState((st) => ({ tabs: { ...st.tabs, [id]: { ...st.tabs[id], page } } }));
const owns = (t) => hasPage(t) || !!wakeOf(t);

function oncePerWindowAndOnePage(windowIds) {
  for (const w of windowIds) {
    const keys = S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === "default").map(pinKeyOf);
    assert.equal(new Set(keys).size, keys.length, "each tab is listed once in each window, split panes included");
  }
  const live = Object.values(S().tabs).filter(hasPage).map(pinKeyOf);
  assert.equal(new Set(live).size, live.length, "one live page per tab");
}

test("ungrouping a split folder mirrored across two windows leaves no regular copy of a pane, and no second live page", () => {
  const { a, b, group } = splitOnlyFolder();
  S().ungroup(folderOf(b, group).id);
  oncePerWindowAndOnePage([a, b]);
  const panes = splitTabIds(splitsIn(b)[0]).map((id) => S().tabs[id]);
  assert.ok(panes.every(hasPage), "the split keeps both live pages");
  for (const t of rows(a)) {
    S().setFocusedWindow(a);
    S().activate(t.id);
    oncePerWindowAndOnePage([a, b]);
  }
  S().separateSplit(splitsIn(b)[0].id);
  oncePerWindowAndOnePage([a, b]);
  for (const t of panes) for (const w of [a, b]) assert.equal(rows(w).filter((x) => pinKeyOf(x) === pinKeyOf(t)).length, 1, "a separated pane is shared again, once per window");
  for (const id of S().windows[a].tabIds) {
    S().setFocusedWindow(a);
    S().activate(id);
    oncePerWindowAndOnePage([a, b]);
  }
});

test("separating a kept split keeps a sleeping pane's restore and the live copy of its address from the other window", () => {
  const { a, b, group } = splitOnlyFolder();
  const home = splitTabIds(splitsIn(b)[0]).find((id) => S().tabs[id].url === site("one"));
  const away = splitTabIds(splitsIn(a)[0]).find((id) => S().tabs[id].url === site("one"));
  pageAs(home, withWake(ASLEEP, "restore:old-home"));
  pageAs(away, loadedPage(navigationTo(site("one"))));
  const closed = S().closedTabs.length;
  S().ungroup(folderOf(b, group).id);
  S().setFocusedWindow(a);
  S().activate(away);
  S().separateSplit(splitsIn(b)[0].id);
  const tokens = Object.values(S().tabs).flatMap((t) => [wakeOf(t), adoptOf(t)]);
  assert.ok(tokens.includes("restore:old-home"), "the pane's own restore is still there");
  assert.ok(S().tabs[away] && hasPage(S().tabs[away]), "the other window's live page is still open");
  assert.notEqual(pinKeyOf(S().tabs[away]), pinKeyOf(S().tabs[home]), "as tabs of their own");
  assert.equal(S().closedTabs.length, closed, "nothing goes to Recently Closed");
  oncePerWindowAndOnePage([a, b]);
});

test("across three windows, ungrouping keeps each pending restore at its own address", () => {
  const { a, b, all, one, group } = windows(true, 3);
  const c = all.find((w) => w !== a && w !== b);
  const key = pinKeyOf(S().groups[group]);
  const copyIn = (w) => groupIn(w, key).tabIds.find((id) => pinKeyOf(S().tabs[id]) === one);
  const [inA, inC] = [copyIn(a), copyIn(c)];
  S().updateTab(inA, { url: site("elsewhere") });
  pageAs(inA, withWake(ASLEEP, "restore:old-a"));
  pageAs(inC, withWake(ASLEEP, "restore:old-c"));
  S().ungroup(groupIn(b, key).id);
  const holding = (token) => Object.values(S().tabs).find((t) => wakeOf(t) === token || adoptOf(t) === token);
  assert.equal(holding("restore:old-a")?.url, site("elsewhere"), "the restore that moved keeps its address");
  assert.equal(holding("restore:old-c")?.url, site("one"), "the other restore keeps its own");
  assert.notEqual(pinKeyOf(holding("restore:old-a")), pinKeyOf(holding("restore:old-c")), "two addresses with their own restores are two tabs");
});

test("after a restart, ungrouping keeps a pane in another window that moved to another page, with its restore", () => {
  const { a, b, group } = splitOnlyFolder();
  const away = splitTabIds(splitsIn(a)[0]).find((id) => S().tabs[id].url === site("one"));
  const moved = `${site("one")}moved`;
  S().updateTab(away, { url: moved });
  pageAs(away, withWake(ASLEEP, "restore:old-a"));
  S().ungroup(folderOf(b, group).id);
  assert.ok(S().tabs[away], "the pane survives");
  assert.equal(S().tabs[away].url, moved, "at the page it moved to");
  assert.ok(pendingRestore(S().tabs[away]) === "old-a" || adoptOf(S().tabs[away]) === "restore:old-a", "still able to restore its page");
});

test("ungrouping keeps a regular tab that shares a folder tab's family and waits on a restore", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  const two = S().newTab(a, { url: site("two"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const group = S().groupTabs([S().windows[a].tabIds[0], two], { pinned: true });
  const member = S().groups[group].tabIds[0];
  const extra = S().newTab(b, { url: site("one"), background: true });
  useBrowser.setState((st) => ({ tabs: { ...st.tabs, [extra]: { ...st.tabs[extra], pinKey: pinKeyOf(st.tabs[member]), page: withWake(ASLEEP, "restore:old-b") } } }));
  S().ungroup(folderOf(b, group).id);
  const kept = Object.values(S().tabs).some((t) => pendingRestore(t) === "old-b" || adoptOf(t) === "restore:old-b");
  assert.ok(kept, "the tab waiting on restore:old-b is still there");
  assert.equal(Object.values(S().groups).filter((g) => g.pinned).length, 0);
});

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generatedLayout(seed) {
  const r = seeded(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  S().hydrate({});
  const all = [];
  for (let i = 0, n = 2 + Math.floor(r() * 2); i < n; i++) all.push(S().createWindow({ url: site(`w${i}`) }));
  for (let i = 0; i < 3; i++) S().newTab(all[0], { url: site(`t${i}`), background: true });
  if (r() < 0.3) {
    const other = S().createProfile({ name: "Work" });
    const w = S().createWindow({ url: site("p0"), profileId: other });
    S().newTab(w, { url: site("p1"), background: true });
    if (r() < 0.5) S().switchProfile(pick(all), other);
  }
  S().updateSettings({ shareTabsAcrossWindows: true });
  const where = pick(all);
  const members = viewTabIds(S(), where).filter((id) => !inPinnedContainer(S(), id)).slice(0, 2 + Math.floor(r() * 2));
  S().setFocusedWindow(where);
  const group = S().groupTabs(members, { pinned: true });
  const split = r() < 0.6;
  if (split) {
    S().setFocusedWindow(pick(all));
    S().createSplit(S().groups[group].tabIds.slice(0, 2));
  }
  const key = pinKeyOf(S().groups[group]);
  const copies = () => Object.values(S().groups).filter((g) => g.pinned && pinKeyOf(g) === key);
  for (const g of copies()) {
    for (const id of g.tabIds) {
      const roll = r();
      if (roll < 0.25) pageAs(id, loadedPage(navigationTo(S().tabs[id].url)));
      else if (roll < 0.4) pageAs(id, withWake(ASLEEP, `restore:old-${id}`));
      else if (roll < 0.5) pageAs(id, adoptedPage(`restore:old-${id}`, navigationTo(S().tabs[id].url)));
      if (r() < 0.15 && S().tabs[id]) S().updateTab(id, { url: site(`moved${Math.floor(r() * 9)}`) });
    }
  }
  if (r() < 0.35) {
    const member = S().tabs[pick(pick(copies()).tabIds)];
    const extra = S().newTab(pick(all), { url: member.url, background: true });
    useBrowser.setState((st) => ({ tabs: { ...st.tabs, [extra]: { ...st.tabs[extra], pinKey: pinKeyOf(member) } } }));
    if (r() < 0.5) pageAs(extra, withWake(ASLEEP, `restore:old-${extra}`));
  }
  if (r() < 0.5) S().setFocusedWindow(pick(all));
  return { from: pick(copies()), key, split };
}

function ownersKept(owners, familyOf, at) {
  const held = new Set(Object.values(S().tabs).flatMap((t) => [wakeOf(t), adoptOf(t)]).filter(Boolean));
  for (const o of owners) {
    const t = S().tabs[o.id];
    const token = wakeOf(o) ?? adoptOf(o);
    const holder = t && S().tabs[holderOfPage(t)];
    const sharesPage = !!holder && holder.id !== t.id && familyOf[holder.id] === familyKeyOf(o) && holder.url === t.url && owns(holder);
    const kept = token ? held.has(token) : !!t && (hasPage(t) || sharesPage);
    assert.ok(kept, `${at}, ${o.id} keeps ${token ? `its own restore ${token}` : "its own page"}`);
  }
}

for (const action of ["ungrouping", "unpinning"]) test(`across 200 generated layouts, ${action} a shared folder never drops a tab that owns a page or takes another tab's address`, () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { from, key, split } = generatedLayout(seed);
    const before = S();
    const owners = Object.values(before.tabs).filter(owns);
    const families = new Map();
    for (const t of Object.values(before.tabs)) families.set(familyKeyOf(t), new Set([...(families.get(familyKeyOf(t)) ?? []), t.url]));
    const familyOf = Object.fromEntries(Object.values(before.tabs).map((t) => [t.id, familyKeyOf(t)]));
    const closed = before.closedTabs.length;
    if (action === "ungrouping") S().ungroup(from.id);
    else S().updateGroup(from.id, { pinned: false });
    const at = `seed ${seed}`;
    assert.equal(S().closedTabs.length, closed, `${at}: nothing goes to Recently Closed`);
    ownersKept(owners, familyOf, `${at}: after ${action}`);
    for (const t of Object.values(S().tabs)) if (familyOf[t.id]) assert.ok(families.get(familyOf[t.id]).has(t.url), `${at}: ${t.id} keeps an address of its own tab`);
    for (const t of Object.values(S().tabs)) if (before.tabs[t.id] && (hasOwnOrSharedPage(before.tabs[t.id]) || wakeOf(before.tabs[t.id]))) assert.equal(t.url, before.tabs[t.id].url, `${at}: ${t.id} keeps its own address`);
    assert.ok(!Object.values(S().groups).some((g) => g.pinned && pinKeyOf(g) === key), `${at}: no folder is left`);
    if (split) {
      assert.ok(Object.values(S().splits).some((v) => v.windowId === from.windowId), `${at}: the split stays in the window it was ${action === "ungrouping" ? "ungrouped" : "unpinned"} from`);
      assert.ok(Object.values(S().splits).every((v) => v.windowId === from.windowId), `${at}: the split stays in one window`);
    }
    for (const v of Object.values(S().splits)) S().separateSplit(v.id);
    ownersKept(owners, familyOf, `${at}: once the split is separated`);
  }
});

for (const origin of ["original window", "mirror window"]) {
  test(`unpinning a shared pinned folder from its ${origin} keeps its tabs in every window, as a regular folder`, () => {
    const { a, b, all, one, two, group } = windows(true, 3);
    const before = Object.fromEntries([one, two].map((id) => [id, S().tabs[id].page.nav]));
    const key = pinKeyOf(S().groups[group]);
    const closed = S().closedTabs.length;
    S().updateGroup(groupIn(origin === "original window" ? b : a, key).id, { pinned: false });
    for (const w of all) {
      const folder = groupIn(w, key);
      assert.ok(folder && !folder.pinned, "each window keeps the folder, unpinned");
      for (const id of [one, two]) assert.equal(rows(w).filter((t) => pinKeyOf(t) === id).length, 1, "each tab listed once");
    }
    for (const id of [one, two]) assert.deepEqual(S().tabs[id].page.nav, before[id], "the live pages stay, without a reload");
    assert.equal(S().closedTabs.length, closed);
  });
}

test("unpinning a shared folder keeps an adopted copy in a third window", () => {
  const { a, b, all, group } = windows(true, 3);
  const key = pinKeyOf(S().groups[group]);
  const third = all.find((w) => w !== a && w !== b);
  const copy = groupIn(third, key).tabIds[0];
  useBrowser.setState((st) => {
    const tabs = { ...st.tabs };
    for (const t of Object.values(st.tabs)) if (pinKeyOf(t) === pinKeyOf(st.tabs[copy]) && t.id !== copy) tabs[t.id] = { ...t, page: ASLEEP };
    tabs[copy] = { ...st.tabs[copy], page: adoptedPage(`restore:old-${copy}`, navigationTo(st.tabs[copy].url)) };
    return { tabs };
  });
  assert.equal(adoptOf(S().tabs[copy]), `restore:old-${copy}`, "the copy is the tab's only page, adopted after a relaunch");
  S().updateGroup(groupIn(b, key).id, { pinned: false });
  const kept = Object.values(S().tabs).some((t) => adoptOf(t) === `restore:old-${copy}` || pendingRestore(t) === `old-${copy}` || (t.id === copy && hasPage(t)));
  assert.ok(kept, "the adopted page is still open");
});

test("without shared tabs, ungrouping a pinned folder keeps its tabs in the invoking window", () => {
  const { b, one, two, group } = windows(false);
  const key = pinKeyOf(S().groups[group]);
  S().ungroup(groupIn(b, key).id);
  for (const id of [one, two]) {
    const copies = rows(b).filter((t) => t.url === `https://${id === one ? "one" : "two"}.example/`);
    assert.equal(copies.length, 1);
    assert.equal(inPinnedContainer(S(), copies[0].id), false);
  }
});

test("shared ungroup ignores matching keys in other profiles and private or small windows", () => {
  const group = (id, windowId, profileId = "default", extra = {}) => ({
    id, windowId, profileId, pinKey: "folder", name: id, icon: null, color: null,
    collapsed: false, pinned: true, tabIds: [], createdAt: 0, ...extra,
  });
  const window = (id, kind, profileId = "default") => ({ id, kind, profileId, tabIds: [], activeTabIds: {}, frame: null, createdAt: 0 });
  let s = {
    settings: { shareTabsAcrossWindows: true }, tabs: {},
    windows: { a: window("a", "main"), b: window("b", "main", "work"), work: window("work", "main", "work"), p: window("p", "private"), small: window("small", "small") },
    groups: { a: group("a", "a"), b: group("b", "b"), work: group("work", "work", "work"), p: group("p", "p"), small: group("small", "small"), list: group("list", "a", "default", { pinned: false }), other: group("other", "a", "default", { pinKey: "other" }) },
  };
  const before = s;
  const slice = createGroupsSlice((change) => { s = { ...s, ...change(s) }; }, () => s, {});
  slice.ungroup("a");
  assert.equal(s.groups.a, undefined);
  assert.equal(s.groups.b, undefined, "a mirror of an inactive profile is still ungrouped");
  for (const id of ["work", "p", "small", "list", "other"]) assert.equal(s.groups[id], before.groups[id], `${id} is untouched`);
  for (const id of ["p", "small", "list", "other"]) {
    s = before;
    slice.ungroup(id);
    assert.equal(s.groups[id], undefined);
    assert.equal(s.groups.a, before.groups.a, "a non-shared source only removes its own container");
    assert.equal(s.groups.b, before.groups.b);
  }
  s = { ...before, groups: { ...before.groups, gone: group("gone", "gone") } };
  slice.ungroup("gone");
  assert.equal(s.groups.gone, undefined, "a group whose window is gone still uses the original fallback");
  assert.equal(s.groups.a, before.groups.a);
});

test("shared ungroup preserves pages and unrelated order across 100 window, owner and profile combinations", () => {
  const cases = [];
  for (const count of [2, 3]) for (const size of [1, 2, 3, 4, 5]) for (const source of [0, 1]) for (const target of [0, 1]) for (const inactive of [false, true]) cases.push({ count, size, source, target, inactive });
  for (const size of [2, 3, 4, 5, 6]) for (const target of [0, 1]) for (const inactive of [false, true]) cases.push({ count: 3, size, source: 2, target, inactive });
  assert.equal(cases.length, 100);
  for (const [index, { count, size, source, target, inactive }] of cases.entries()) {
    S().hydrate({});
    const all = Array.from({ length: count }, (_, n) => S().createWindow({ url: `https://unrelated${n}.example/` }));
    const ids = Array.from({ length: size }, (_, n) => S().newTab(all[n % count], { url: `https://member${n}.example/`, background: true }));
    S().updateSettings({ shareTabsAcrossWindows: true });
    const members = ids.map((id) => rows(all[source]).find((t) => pinKeyOf(t) === id).id);
    const group = S().groupTabs(members, { pinned: true, name: "Reading" });
    const key = pinKeyOf(S().groups[group]);
    const before = Object.fromEntries(ids.map((id) => [id, S().tabs[id].page.nav]));
    const unrelated = all.map((w) => rows(w).filter((t) => !ids.includes(pinKeyOf(t))).map(pinKeyOf));
    if (inactive) {
      const work = S().createProfile({ name: "Work" });
      for (const w of all) S().switchProfile(w, work);
    }
    S().ungroup(groupIn(all[target], key).id);
    for (const w of all) {
      assert.equal(groupIn(w, key), undefined, `case ${index}: the folder is gone`);
      const profileRows = S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === "default");
      assert.deepEqual(profileRows.filter((t) => !ids.includes(pinKeyOf(t))).map(pinKeyOf), unrelated[all.indexOf(w)], `case ${index}: unrelated order is kept`);
      for (const id of ids) assert.equal(profileRows.filter((t) => pinKeyOf(t) === id).length, 1, `case ${index}: each member is listed once`);
      for (const active of Object.values(S().windows[w].activeTabIds)) assert.ok(S().tabs[active], `case ${index}: remembered selections stay valid`);
    }
    keptPages(ids, before);
  }
});

test("ungrouping a shared folder whose tab is in a split with a Top App keeps one copy of that tab and one live page", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().newTab(a, { url: site("two"), background: true });
  S().newTab(a, { url: site("app"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
  S().pinTabs([pick(b, "app")], true);
  const group = S().groupTabs([pick(b, "one"), pick(b, "two")], { pinned: true });
  S().setFocusedWindow(b);
  S().createSplit([pick(b, "app"), pick(b, "one")]);
  const closed = S().closedTabs.length;
  S().ungroup(folderOf(b, group).id);
  for (const w of [a, b]) {
    const keys = S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === "default").map(pinKeyOf);
    assert.equal(new Set(keys).size, keys.length, "no tab is listed twice in a window, split panes included");
  }
  const live = Object.values(S().tabs).filter(hasPage).map(pinKeyOf);
  assert.equal(new Set(live).size, live.length, "one live page per tab");
  const split = splitsIn(b)[0];
  assert.ok(split, "the split stays where it was");
  assert.ok(splitTabIds(split).some((id) => S().tabs[id].url === site("one") && hasPage(S().tabs[id])), "with the folder's tab and its live page");
  assert.equal(rows(a).filter((t) => t.url === site("two")).length, 1, "the folder's other tab stays in every window");
  assert.equal(S().closedTabs.length, closed);
});

test("across three windows with no live page, the copy waiting on a restore gives the tab its address", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().newTab(a, { url: site("two"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const c = S().createWindow({ url: site("c") });
  const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
  const group = S().groupTabs([pick(b, "one"), pick(b, "two")], { pinned: true });
  const copyIn = (w) => folderOf(w, group).tabIds.find((id) => S().tabs[id].url === site("one"));
  const family = pinKeyOf(S().tabs[copyIn(b)]);
  useBrowser.setState((st) => ({ tabs: Object.fromEntries(Object.entries(st.tabs).map(([id, t]) => [id, pinKeyOf(t) === family ? { ...t, page: { kind: "idle" } } : t])) }));
  const inC = copyIn(c);
  S().updateTab(inC, { url: site("moved") });
  pageAs(inC, withWake(ASLEEP, "restore:old-c"));
  S().setFocusedWindow(b);
  S().ungroup(folderOf(b, group).id);
  for (const w of [a, b, c]) assert.equal(rows(w).filter((t) => t.url === site("one") || t.url === site("moved")).length, 1, "each window lists the tab once, not its stale address beside it");
  for (const w of [a, b, c]) assert.ok(rows(w).some((t) => t.url === site("moved")), "at the address its restore holds");
  assert.equal(Object.values(S().tabs).find((t) => wakeOf(t) === "restore:old-c" || adoptOf(t) === "restore:old-c")?.url, site("moved"), "the restore keeps its address");
});

test("ungrouping a shared folder from another window keeps a split with a Top App where it is, with one copy of its tab", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().newTab(a, { url: site("two"), background: true });
  S().newTab(a, { url: site("app"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
  S().pinTabs([pick(b, "app")], true);
  const group = S().groupTabs([pick(b, "one"), pick(b, "two")], { pinned: true });
  S().setFocusedWindow(b);
  S().createSplit([pick(b, "app"), pick(b, "one")]);
  assert.equal(splitsIn(a).length, 0, "the split is only in the window that made it");
  const closed = S().closedTabs.length;
  S().setFocusedWindow(a);
  S().ungroup(folderOf(a, group).id);
  for (const w of [a, b]) {
    const keys = S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === "default").map(pinKeyOf);
    assert.equal(new Set(keys).size, keys.length, "no tab is listed twice in a window, split panes included");
  }
  const live = Object.values(S().tabs).filter(hasPage).map(pinKeyOf);
  assert.equal(new Set(live).size, live.length, "one live page per tab");
  const split = splitsIn(b)[0];
  assert.ok(split && splitTabIds(split).some((id) => S().tabs[id].url === site("one") && hasPage(S().tabs[id])), "the split stays in its window with the tab's live page");
  assert.equal(splitsIn(a).length, 0);
  assert.equal(S().closedTabs.length, closed);
});

test("ungrouping a shared folder keeps two splits made separately in two other windows with the same tabs", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  S().newTab(a, { url: site("two"), background: true });
  S().newTab(a, { url: site("app"), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const c = S().createWindow({ url: site("c") });
  const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
  S().pinTabs([pick(b, "app")], true);
  const group = S().groupTabs([pick(b, "one"), pick(b, "two")], { pinned: true });
  for (const [w, orientation] of [[b, "horizontal"], [c, "vertical"]]) {
    S().setFocusedWindow(w);
    S().createSplit([pick(w, "app"), pick(w, "one")]);
    const made = splitsIn(w)[0];
    assert.ok(made, "each window makes its own split");
    useBrowser.setState((st) => ({ splits: { ...st.splits, [made.id]: { ...made, orientation } } }));
  }
  const closed = S().closedTabs.length;
  S().setFocusedWindow(a);
  S().ungroup(folderOf(a, group).id);
  for (const w of [b, c]) {
    const kept = splitsIn(w);
    assert.equal(kept.length, 1, "both splits survive");
    assert.ok(splitTabIds(kept[0]).some((id) => S().tabs[id].url === site("one")), "each with its pane of the folder's tab");
  }
  assert.equal(splitsIn(b)[0].orientation, "horizontal");
  assert.equal(splitsIn(c)[0].orientation, "vertical");
  for (const w of [a, b, c]) {
    const keys = S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === "default").map(pinKeyOf);
    assert.equal(new Set(keys).size, keys.length, "no tab is listed twice in a window, split panes included");
  }
  const live = Object.values(S().tabs).filter(hasPage).map(pinKeyOf);
  assert.equal(new Set(live).size, live.length, "one live page per tab");
  assert.equal(S().closedTabs.length, closed);
});

test("ungrouping one of two shared pinned folders that a mirrored split spans keeps one split, in the invoking window", () => {
  S().hydrate({});
  const a = S().createWindow({ url: site("one") });
  for (const name of ["two", "three", "four"]) S().newTab(a, { url: site(name), background: true });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const b = S().createWindow({ url: site("b") });
  const pick = (w, name) => rows(w).find((t) => t.url === site(name)).id;
  const first = S().groupTabs([pick(b, "one"), pick(b, "two")], { pinned: true, name: "First" });
  const second = S().groupTabs([pick(b, "three"), pick(b, "four")], { pinned: true, name: "Second" });
  const secondKey = pinKeyOf(S().groups[second]);
  S().setFocusedWindow(b);
  S().createSplit([pick(b, "one"), pick(b, "three")]);
  assert.equal(splitsIn(a).length, 1, "the split across two pinned folders is mirrored");
  const paneOf = (w) => splitTabIds(splitsIn(w)[0]).find((id) => S().tabs[id].url === site("one"));
  pageAs(paneOf(a), ASLEEP);
  pageAs(paneOf(b), loadedPage(navigationTo(site("one"))));
  const closed = S().closedTabs.length;
  S().setFocusedWindow(a);
  S().ungroup(folderOf(a, first).id);
  assert.equal(Object.values(S().splits).length, 1, "one split is left");
  assert.equal(splitsIn(a).length, 1, "in the window it was ungrouped from");
  assert.ok(hasPage(S().tabs[splitTabIds(splitsIn(a)[0]).find((id) => S().tabs[id].url === site("one"))]), "holding the live page from the other window's copy");
  for (const w of [a, b]) {
    const keys = S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === "default").map(pinKeyOf);
    assert.equal(new Set(keys).size, keys.length, "no tab is listed twice in a window, split panes included");
    const kept = Object.values(S().groups).find((g) => g.windowId === w && pinKeyOf(g) === secondKey);
    assert.ok(kept?.pinned, "the other folder stays pinned in every window");
  }
  const live = Object.values(S().tabs).filter(hasPage).map(pinKeyOf);
  assert.equal(new Set(live).size, live.length, "one live page per tab");
  assert.equal(S().closedTabs.length, closed);
});
