import assert from "node:assert/strict";
import { after, test } from "node:test";
await import("../../test-native/index.ts");
const D = await import("./fixtures/dragScene.mjs");
const { world, regionsOf } = await import("./fixtures/dragWorld.mjs");
const { devTabPresses } = await import("../../state/telemetry/tabPresses.ts");
const client = await import("../../state/telemetry/client.ts");
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { dragMarksOf } = await import("../../state/sidebar/dragMarks.ts");
const { EDGE_HOLD_MS, PROFILE_HOLD_MS } = await import("./dragProfiles.ts");
const { viewTabIds } = await import("../../state/browser/model.ts");
const { S, entryKey, sceneLayout, mount, fakeView, settle, escapeCapture } = D;

const DOTS_Y = 860;
const dotFrame = (i) => ({ x: 70 + i * 26, y: DOTS_Y, w: 26, h: 28 });
const overDot = (i) => ({ x: dotFrame(i).x + 13, y: DOTS_Y + 14 });

function spaces({ warn = false } = {}) {
  const W = world("a", "b", "c", "d", "t1");
  const { w, id } = W;
  S().updateSettings({ warnBeforeMovingTabsToProfile: warn });
  S().pinTabs([id.t1], true);
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  id.x = S().windows[w].activeTabIds[work];
  S().navigate(id.x, "https://x.com/");
  for (const h of ["y", "z"]) id[h] = S().newTab(w, { url: `https://${h}.com/`, background: true });
  S().switchProfile(w, "default");
  S().activate(id.a);
  const home = sceneLayout({ top: 60 });
  const grid = home.tiles([id.t1]).frame;
  home.skip(20);
  const homeList = home.y;
  home.row(id.a).row(id.b).row(id.c).row(id.d).tail("list");
  const away = sceneLayout({ top: 60 });
  const awayList = away.y;
  away.row(id.x).row(id.y).row(id.z).tail("list");
  return {
    ...W,
    work,
    home: { L: home, regions: { tiles: grid, ...regionsOf(home, { list: [homeList, home.y] }) } },
    away: { L: away, regions: regionsOf(away, { list: [awayList, away.y] }) },
  };
}

function itemsOf(c, page) {
  return new Map(
    page.L.entries.map((e) => {
      const item = c.create(e.key);
      Object.assign(item, e.spec);
      item.view = fakeView(e.frame);
      return [e.key, item];
    }),
  );
}

async function showPage(c, profileId, items, regions) {
  c.items.clear();
  for (const [key, item] of items) c.items.set(key, item);
  c.regions.clear();
  for (const [name, frame] of Object.entries(regions)) c.regions.set(name, fakeView(frame));
  c.profileShown(profileId);
  await settle();
  await settle();
}

function setup(options) {
  const m = spaces(options);
  const { c, ghosts } = mount({ entries: m.home.L.entries, regions: m.home.regions });
  const homeItems = new Map(c.items);
  const awayItems = itemsOf(c, m.away);
  for (const [i, profileId] of S().profileOrder.entries()) c.profiles.views.set(profileId, fakeView(dotFrame(i)));
  c.profileShown("default");
  const frame = (key) => [...m.home.L.entries, ...m.away.L.entries].find((e) => e.key === key).frame;
  const toAway = () => showPage(c, m.work, awayItems, m.away.regions);
  const toHome = () => showPage(c, "default", homeItems, m.home.regions);
  return { m, c, ghosts, frame, toAway, toHome };
}

const counts = () => {
  const t = devTabPresses();
  return { switches: t.drag_profile_switches, holds: t.drag_profile_holds, other: t.drops_other_profile, icon: t.drops_profile_icon, edges: t.drag_profile_edge_holds };
};
const delta = (before) => Object.fromEntries(Object.entries(counts()).map(([k, v]) => [k, v - before[k]]));
const names = (w, profileId) => viewTabIds(S(), w, profileId).map((id) => new URL(S().tabs[id].pinnedUrl || S().tabs[id].url).hostname.replace(".com", ""));

test("holding a dragged tab over another profile's icon lights it, switches after the hold, and the drop lands at the slot there", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { m, c, ghosts, frame, toAway } = setup();
  const before = counts();
  const b = frame(entryKey("tab", m.id.b));
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  c.move(60, 300);
  c.move(overDot(1).x, overDot(1).y);
  assert.equal(dragMarksOf(c.marks).profileHold, m.work);
  assert.equal(D.readDrag(c).gapKey, null, "no gap opens while over the switcher");
  t.mock.timers.tick(PROFILE_HOLD_MS - 1);
  assert.equal(S().windows[m.w].profileId, "default", "not before the hold");
  t.mock.timers.tick(1);
  assert.equal(dragMarksOf(c.marks).profileHold, null);
  assert.equal(S().windows[m.w].profileId, m.work, "the hold switched the window");
  await toAway();
  assert.ok(ghosts.at(-1) && !ghosts.at(-1).landing, "the ghost stays up across the switch");
  const z = frame(entryKey("tab", m.id.z));
  c.move(60, z.y + 2);
  const read = D.readDrag(c);
  assert.deepEqual(read.drop, { type: "tabs", placement: { pinned: false, beforeId: m.id.z }, sequence: read.drop.sequence });
  assert.equal(read.gapKey, entryKey("tab", m.id.z), "the other profile's rows open the gap");
  c.end(true);
  await settle();
  assert.equal(ghosts.at(-1), null, "no landing slide into a page it never left");
  assert.deepEqual(names(m.w, m.work), ["x", "y", "b", "z"]);
  assert.deepEqual(names(m.w, "default"), ["t1", "a", "c", "d"]);
  assert.equal(S().windows[m.w].activeTabIds[m.work], m.id.b);
  assert.deepEqual(delta(before), { switches: 1, holds: 1, other: 1, icon: 0, edges: 0 });
});

test("Escape after switching puts everything back: nothing moves, the window returns home and the ghost goes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { m, c, ghosts, frame, toAway } = setup();
  const order = [...S().windows[m.w].tabIds];
  const b = frame(entryKey("tab", m.id.b));
  escapeCapture.length = 0;
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  c.move(60, 300);
  S().switchProfile(m.w, m.work);
  await toAway();
  c.move(60, frame(entryKey("tab", m.id.y)).y + 2);
  assert.equal(D.readDrag(c).drop.type, "tabs");
  c.end(false);
  await settle();
  assert.equal(c.active, false);
  assert.equal(ghosts.at(-1), null);
  assert.deepEqual(S().windows[m.w].tabIds, order);
  assert.equal(S().tabs[m.id.b].profileId, "default");
  assert.equal(S().windows[m.w].profileId, "default");
  assert.deepEqual(escapeCapture, [true, false]);
  c.end(true);
  assert.equal(ghosts.at(-1), null, "the gesture's late release finds nothing to drop");
});

test("a touch the system cancels mid-drag (a key pressed while the button is held) ends it where it is: nothing moves, the switch stands", async () => {
  const { m, c, ghosts, frame, toAway } = setup();
  const order = [...S().windows[m.w].tabIds];
  const b = frame(entryKey("tab", m.id.b));
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  c.move(60, 300);
  S().switchProfile(m.w, m.work);
  await toAway();
  c.move(60, frame(entryKey("tab", m.id.y)).y + 2);
  c.interrupt();
  await settle();
  assert.equal(c.active, false);
  assert.equal(ghosts.at(-1), null);
  assert.deepEqual(S().windows[m.w].tabIds, order);
  assert.equal(S().windows[m.w].profileId, m.work);
});

test("a drop with no slot in the other profile, or a declined warning, cancels back home", async () => {
  for (const [warn, at] of [
    [false, () => ({ x: 400, y: 300 })],
    [true, (frame, m) => ({ x: 60, y: frame(entryKey("tab", m.id.y)).y + 2 })],
  ]) {
    const { m, c, ghosts, frame, toAway } = setup({ warn });
    const order = [...S().windows[m.w].tabIds];
    const b = frame(entryKey("tab", m.id.b));
    await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
    c.move(60, 300);
    S().switchProfile(m.w, m.work);
    await toAway();
    const p = at(frame, m);
    c.move(p.x, p.y);
    c.end(true);
    await settle();
    await settle();
    assert.equal(ghosts.at(-1), null);
    assert.deepEqual(S().windows[m.w].tabIds, order, `warn ${warn}`);
    assert.equal(S().windows[m.w].profileId, "default", `warn ${warn}`);
  }
});

test("dragging back home mid-drag is an ordinary reorder that lands on its row", async () => {
  const { m, c, ghosts, frame, toAway, toHome } = setup();
  const b = frame(entryKey("tab", m.id.b));
  const before = counts();
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  c.move(60, 300);
  S().switchProfile(m.w, m.work);
  await toAway();
  S().switchProfile(m.w, "default");
  await toHome();
  c.move(60, frame(entryKey("tab", m.id.d)).y + 2);
  assert.deepEqual(D.readDrag(c).drop.placement, { pinned: false, beforeId: m.id.d });
  c.end(true);
  assert.ok(ghosts.some((g) => g?.landing), "it slides onto its new row");
  assert.deepEqual(names(m.w, "default"), ["t1", "a", "c", "b", "d"]);
  assert.deepEqual(names(m.w, m.work), ["x", "y", "z"]);
  assert.deepEqual(delta(before), { switches: 2, holds: 0, other: 0, icon: 0, edges: 0 });
});

test("let go on another profile's icon before the hold ends: moved there as Move Tab to Profile places it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { m, c, frame } = setup();
  const before = counts();
  const t1 = frame(entryKey("tab", m.id.t1));
  await c.begin(entryKey("tab", m.id.t1), t1.x + 10, t1.y + 10);
  c.move(60, 300);
  c.move(overDot(1).x, overDot(1).y);
  c.end(true);
  await settle();
  assert.equal(S().tabs[m.id.t1].profileId, m.work);
  assert.equal(S().tabs[m.id.t1].pin?.as, "tile", "a tile stays a tile, as the command keeps it");
  assert.equal(S().windows[m.w].profileId, m.work);
  assert.deepEqual(delta(before), { switches: 0, holds: 0, other: 0, icon: 1, edges: 0 });
  t.mock.timers.tick(PROFILE_HOLD_MS * 2);
  assert.equal(S().windows[m.w].profileId, m.work, "no hold fires after the drop");
});

test("a Top Apps tile dragged into the other profile's list becomes a tab there; its own icon holds nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { m, c, frame, toAway } = setup();
  const t1 = frame(entryKey("tab", m.id.t1));
  await c.begin(entryKey("tab", m.id.t1), t1.x + 10, t1.y + 10);
  c.move(overDot(0).x, overDot(0).y);
  assert.equal(dragMarksOf(c.marks).profileHold, null, "the profile on screen has nothing to switch to");
  S().switchProfile(m.w, m.work);
  await toAway();
  c.move(60, frame(entryKey("tab", m.id.x)).y + 2);
  assert.ok(D.readDrag(c).marks.row, "the tile turns into a row ghost over the list");
  c.end(true);
  await settle();
  assert.deepEqual(names(m.w, m.work), ["t1", "x", "y", "z"]);
  assert.equal(S().tabs[m.id.t1].pin ?? null, null);
  assert.deepEqual(names(m.w, "default"), ["a", "b", "c", "d"]);
});

test("a group, a split row or a dropped file can't change profile: a switch ends the group's drag where it was", async () => {
  const m = spaces();
  const G = S().groupTabs([m.id.c, m.id.d], { name: "G", pinned: false });
  const L = sceneLayout({ top: 60 });
  const listTop = L.y;
  L.row(m.id.a).row(m.id.b);
  L.group(G, {}, (n) => L.row(m.id.c, n).row(m.id.d, n));
  L.tail("list");
  const { c, ghosts } = mount({ entries: L.entries, regions: regionsOf(L, { list: [listTop, L.y] }) });
  c.profileShown("default");
  const order = [...S().windows[m.w].tabIds];
  const g = L.entries.find((e) => e.key === entryKey("group", G)).frame;
  await c.begin(entryKey("group", G), g.x + 20, g.y + 10);
  c.move(60, 100);
  S().switchProfile(m.w, m.work);
  c.profileShown(m.work);
  assert.equal(c.active, false);
  assert.equal(ghosts.at(-1), null);
  assert.deepEqual(S().windows[m.w].tabIds, order);
  assert.equal(S().windows[m.w].profileId, m.work, "the switch itself stands");
  await c.beginExternal(1, 60, 300);
  c.profileShown("default");
  assert.equal(c.active, true, "a file drag measures the page now shown instead");
  c.finishExternal(false);
});

test("with one profile nothing is held or measured for the switcher", async () => {
  const W = world("a", "b");
  const L = sceneLayout({ top: 60 });
  const top = L.y;
  L.row(W.id.a).row(W.id.b).tail("list");
  const { c } = mount({ entries: L.entries, regions: regionsOf(L, { list: [top, L.y] }) });
  c.profiles.views.set("default", fakeView(dotFrame(0)));
  c.profileShown("default");
  const a = L.entries[0].frame;
  await c.begin(entryKey("tab", W.id.a), a.x + 20, a.y + 10);
  c.move(overDot(0).x, overDot(0).y);
  assert.equal(c.session.home, null);
  assert.equal(c.session.overProfile, null);
  assert.equal(dragMarksOf(c.marks).profileHold, null);
  c.end(false);
});

test("holding at the sidebar's right edge pages to the next profile and the left edge back; the glow mark shows while the hold runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { m, c, frame, toAway, toHome } = setup();
  const before = counts();
  const b = frame(entryKey("tab", m.id.b));
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  c.move(100, 400);
  c.move(196, 400);
  assert.equal(dragMarksOf(c.marks).edgeHold, "right");
  t.mock.timers.tick(EDGE_HOLD_MS - 1);
  assert.equal(S().windows[m.w].profileId, "default", "not before the hold");
  t.mock.timers.tick(1);
  assert.equal(dragMarksOf(c.marks).edgeHold, null, "the glow goes once it switched");
  assert.equal(S().windows[m.w].profileId, m.work);
  await toAway();
  c.move(100, 400);
  c.move(3, 400);
  assert.equal(dragMarksOf(c.marks).edgeHold, "left");
  t.mock.timers.tick(EDGE_HOLD_MS);
  assert.equal(S().windows[m.w].profileId, "default", "the left edge goes to the previous profile, the drag's own");
  await toHome();
  c.end(false);
  assert.deepEqual(delta(before), { switches: 2, holds: 0, other: 0, icon: 0, edges: 2 });
});

test("no profile on that side, no hold and no glow: nothing wraps around", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { m, c, frame } = setup();
  const b = frame(entryKey("tab", m.id.b));
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  c.move(3, 400);
  assert.equal(c.session.edge, "left");
  assert.equal(dragMarksOf(c.marks).edgeHold, null);
  t.mock.timers.tick(EDGE_HOLD_MS * 4);
  assert.equal(S().windows[m.w].profileId, "default");
  c.end(false);
});

test("after an edge switch the band has to be left before it switches again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = spaces();
  const play = S().createProfile({ name: "Play" });
  const { c, ghosts } = mount({ entries: m.home.L.entries, regions: m.home.regions });
  c.profileShown("default");
  const b = m.home.L.entries.find((e) => e.key === entryKey("tab", m.id.b)).frame;
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  c.move(196, 400);
  t.mock.timers.tick(EDGE_HOLD_MS);
  assert.equal(S().windows[m.w].profileId, m.work);
  c.profileShown(m.work);
  await settle();
  c.move(195, 410);
  assert.equal(dragMarksOf(c.marks).edgeHold, null, "still in the band: spent");
  t.mock.timers.tick(EDGE_HOLD_MS * 3);
  assert.equal(S().windows[m.w].profileId, m.work, "no runaway into the next profile");
  c.move(120, 410);
  c.move(196, 410);
  assert.equal(dragMarksOf(c.marks).edgeHold, "right", "re-armed once it left the band");
  t.mock.timers.tick(EDGE_HOLD_MS);
  assert.equal(S().windows[m.w].profileId, play);
  c.end(false);
  assert.ok(ghosts.length);
});

test("a row's split halves are not offered in the edge band", async () => {
  const { m, c, frame } = setup();
  c.splitView = true;
  const a = frame(entryKey("tab", m.id.a));
  const d = frame(entryKey("tab", m.id.d));
  await c.begin(entryKey("tab", m.id.a), a.x + 20, a.y + 10);
  c.move(170, d.y + d.h / 2);
  assert.deepEqual(D.readDrag(c).marks.split, { key: entryKey("tab", m.id.d), side: "right" }, "the right half, outside the band");
  c.move(185, d.y + d.h / 2);
  assert.equal(c.session.edge, "right");
  assert.equal(D.readDrag(c).marks.split, null, "inside the band: no half, a gap instead");
  c.end(false);
});

function sharedSpaces() {
  S().hydrate({});
  S().updateSettings({ warnBeforeMovingTabsToProfile: true });
  S().updateProfile("default", { shareTopApps: true });
  const w = S().createWindow({ url: "https://mail.com/" });
  const [mail] = S().windows[w].tabIds;
  const docs = S().newTab(w, { url: "https://docs.com/", background: true });
  const a = S().newTab(w, { url: "https://a.com/", background: true });
  S().pinTabs([mail, docs], true);
  const work = S().createProfile({ name: "Work", shareTopApps: true, shareWith: "default" });
  S().switchProfile(w, work);
  const x = S().newTab(w, { url: "https://x.com/", background: true });
  const y = S().newTab(w, { url: "https://y.com/", background: true });
  const copy = viewTabIds(S(), w, work).find((t) => S().tabs[t].pinnedUrl === "https://mail.com/");
  S().activate(copy);
  S().switchProfile(w, "default");
  S().activate(mail);
  const layout = (profileId) => {
    const L = sceneLayout({ top: 60 });
    const ids = viewTabIds(S(), w, profileId);
    const grid = L.tiles(ids.filter((t) => S().tabs[t].pin?.as === "tile")).frame;
    L.skip(20);
    const top = L.y;
    for (const t of ids.filter((t) => !S().tabs[t].pin)) L.row(t);
    L.tail("list");
    return { L, regions: { tiles: grid, ...regionsOf(L, { list: [top, L.y] }) } };
  };
  return { w, mail, docs, a, x, y, work, layout };
}

const hostOf = (t) => (S().tabs[t].pinnedUrl || S().tabs[t].url ? new URL(S().tabs[t].pinnedUrl || S().tabs[t].url).hostname.replace(".com", "") : "new");
const pinned = (w, p) => viewTabIds(S(), w, p).map((t) => [hostOf(t), S().tabs[t].pin?.as ?? null]);

async function sharedDrag(t, finish) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = sharedSpaces();
  const home = m.layout("default");
  const { c, ghosts } = mount({ entries: home.L.entries, regions: home.regions });
  for (const [i, profileId] of S().profileOrder.entries()) c.profiles.views.set(profileId, fakeView(dotFrame(i)));
  c.profileShown("default");
  const before = { tabs: [...S().windows[m.w].tabIds], home: pinned(m.w, "default"), shown: S().windows[m.w].activeTabIds.default };
  const tile = home.L.entries.find((e) => e.key === entryKey("tab", m.mail)).frame;
  await c.begin(entryKey("tab", m.mail), tile.x + 10, tile.y + 10);
  c.move(60, 300);
  c.move(overDot(1).x, overDot(1).y);
  t.mock.timers.tick(PROFILE_HOLD_MS);
  assert.equal(S().windows[m.w].profileId, m.work);
  const away = m.layout(m.work);
  await showPage(c, m.work, itemsOf(c, away), away.regions);
  await finish(c, m, away);
  await settle();
  await settle();
  return { m, c, ghosts, before };
}

test("a shared Top App dragged into the other profile's list lands there even though the switch handed its live tab over", async (t) => {
  const { m } = await sharedDrag(t, async (c, m, away) => {
    assert.equal(S().tabs[m.mail].profileId, m.work, "the switch swapped the live tile into Work");
    const y = away.L.entries.find((e) => e.key === entryKey("tab", m.y)).frame;
    c.move(60, y.y + 2);
    assert.equal(D.readDrag(c).drop.type, "tabs");
    c.end(true);
  });
  assert.equal(S().windows[m.w].profileId, m.work, "it stays in Work");
  const work = pinned(m.w, m.work);
  assert.deepEqual(work.filter(([h]) => ["x", "mail", "y"].includes(h)), [["x", null], ["mail", null], ["y", null]]);
  assert.equal(S().tabs[S().windows[m.w].activeTabIds[m.work]].pinnedUrl ?? S().tabs[S().windows[m.w].activeTabIds[m.work]].url, "https://mail.com/");
});

test("a shared Top App dragged to another Top Apps slot in the other profile reorders it there", async (t) => {
  const { m } = await sharedDrag(t, async (c, m, away) => {
    const docsTile = away.L.entries.find((e) => e.kind !== "tail" && e.spec.kind === "tile" && S().tabs[e.spec.tabIds[0]].pinnedUrl === "https://docs.com/").frame;
    c.move(docsTile.x + docsTile.w - 3, docsTile.y + docsTile.h / 2);
    const drop = D.readDrag(c).drop;
    assert.equal(drop.type, "tabs");
    assert.equal(drop.placement.pinned, true);
    c.end(true);
  });
  assert.equal(S().windows[m.w].profileId, m.work);
  assert.deepEqual(pinned(m.w, m.work).filter(([, pin]) => pin === "tile").map(([h]) => h), ["docs", "mail"]);
});

test("Escape on a shared Top App after the switch puts both profiles back, the live tile home again", async (t) => {
  const { m, before } = await sharedDrag(t, async (c) => c.end(false));
  assert.equal(S().windows[m.w].profileId, "default");
  assert.deepEqual(pinned(m.w, "default"), before.home);
  assert.equal(S().tabs[m.mail].profileId, "default", "the live tab is back in its own profile");
  assert.equal(S().windows[m.w].activeTabIds.default, before.shown);
});

test("a shared Top App let go on the icon of the profile it was handed to stays there, nothing paged back", async (t) => {
  const { m } = await sharedDrag(t, async (c) => {
    c.move(overDot(1).x, overDot(1).y);
    c.end(true);
  });
  assert.equal(S().windows[m.w].profileId, m.work);
  assert.deepEqual(pinned(m.w, m.work).filter(([, pin]) => pin === "tile").map(([h]) => h), ["mail", "docs"]);
});
