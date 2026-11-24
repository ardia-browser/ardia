import assert from "node:assert/strict";
import { after, test } from "node:test";
await import("../../test-native/index.ts");
const D = await import("./fixtures/dragScene.mjs");
const { world, mixedScene, regionsOf } = await import("./fixtures/dragWorld.mjs");
const { recorder, golden, labeller } = await import("./fixtures/dragTrace.mjs");
const stub = await import("../../test-native/index.ts");
const { flushPersistence, loadSession, startPersistence } = await import("../../state/session/persist.ts");
const { registerRow, setSidebarUi, sidebarUi } = await import("../../state/sidebar/sidebarUi.ts");
const hover = await import("../../state/sidebar/hover.ts");
const { S, entryKey, sceneLayout, mount, animations, escapeCapture } = D;

const traces = golden("dragSession");
after(() => traces.write());

function listScene() {
  const W = world("a", "b", "c", "d", "p1", "t1", "t2");
  const { id } = W;
  S().pinTabs([id.t1, id.t2], true);
  S().pinTabs([id.p1], true, true);
  const L = sceneLayout({ top: 60 });
  const grid = L.tiles([id.t1, id.t2]).frame;
  L.skip(20);
  const pinnedTop = L.y;
  L.row(id.p1, { section: "pinnedRows" }).tail("pinnedGroups");
  L.skip(10);
  const listTop = L.y;
  L.row(id.a).row(id.b).row(id.c).row(id.d).tail("list");
  return { ...W, L, regions: { tiles: grid, ...regionsOf(L, { pinnedGroups: [pinnedTop, listTop], list: [listTop, L.y] }) } };
}

const frameOf = (m, key) => m.L.entries.find((e) => e.key === key).frame;

function ghostLog(ghosts, name) {
  return ghosts.map((g) => (g ? name({ item: g.item.key, count: g.count, width: g.width, height: g.height, landing: !!g.landing, at: g.position.__getValue() }) : null));
}

test("external drops: counted, no ghost, a placement only on commit, and a second entry starts over", async (t) => {
  const m = listScene();
  const { c, ghosts } = mount({ entries: m.L.entries, regions: m.regions });
  const r = recorder(c, m.w);
  await c.beginExternal(2, 60, 300);
  r.snap("enter 2 files");
  r.move(60, frameOf(m, entryKey("tab", m.id.b)).y + 2);
  r.move(60, 80);
  await c.beginExternal(3, 60, 80);
  r.snap("enter again with 3");
  r.move(60, frameOf(m, entryKey("tab", m.id.c)).y + 2);
  const placed = c.finishExternal(true);
  r.snap("finished");
  assert.equal(c.finishExternal(true), null, "a second finish has nothing to give");
  traces.check(t, "external", [...r.steps, r.name({ placed, ghosts: ghostLog(ghosts, r.name) })]);
});

test("external drops: cancelled, finished before measuring, and never over an internal drag", async (t) => {
  const m = listScene();
  const { c, ghosts } = mount({ entries: m.L.entries, regions: m.regions });
  const r = recorder(c, m.w);
  await c.beginExternal(1, 60, 300);
  r.move(60, frameOf(m, entryKey("tab", m.id.b)).y + 2);
  const cancelled = c.finishExternal(false);
  r.snap("cancelled");
  c.root.held = true;
  const pending = c.beginExternal(1, 60, 300);
  const early = c.finishExternal(true);
  c.root.release();
  await pending;
  r.snap("finished before measuring");
  const b = frameOf(m, entryKey("tab", m.id.b));
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  await c.beginExternal(1, 60, 300);
  r.snap("external over an internal drag");
  await r.end(false);
  traces.check(t, "external lifecycle", [...r.steps, r.name({ cancelled, early, ghosts: ghostLog(ghosts, r.name) })]);
});

test("a cancelled row slides home under a fresh token; a new drag before it lands keeps its own ghost", async (t) => {
  const m = listScene();
  const { c, ghosts } = mount({ entries: m.L.entries, regions: m.regions });
  const r = recorder(c, m.w);
  const b = frameOf(m, entryKey("tab", m.id.b));
  await r.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  r.move(60, frameOf(m, entryKey("tab", m.id.d)).y + 30);
  animations.held = true;
  c.end(false);
  await D.settle();
  r.snap("cancelled, landing");
  const a = frameOf(m, entryKey("tab", m.id.a));
  animations.held = false;
  await r.begin(entryKey("tab", m.id.a), a.x + 20, a.y + 10);
  animations.finish();
  await D.settle();
  r.snap("old landing finished");
  r.move(60, frameOf(m, entryKey("tab", m.id.c)).y + 30);
  animations.held = true;
  c.end(true);
  await D.settle();
  r.snap("committed, landing");
  animations.held = false;
  animations.finish();
  await D.settle();
  r.snap("landed");
  traces.check(t, "landing token", [...r.steps, r.name({ ghosts: ghostLog(ghosts, r.name), committed: D.committed(m.w).tabIds })]);
});

test("landing: which drops slide the ghost to its spot and which drop it at once", async (t) => {
  globalThis.__DEV__ = true;
  t.after(() => void (globalThis.__DEV__ = false));
  const out = [];
  const cases = [
    ["row to the list", (m) => entryKey("tab", m.id.a), (m) => ({ x: 60, y: frameOf(m, entryKey("tab", m.id.c)).y + 30 })],
    ["row on a row's right half", (m) => entryKey("tab", m.id.a), (m) => D.centre(frameOf(m, entryKey("tab", m.id.c)))],
    ["row into the pinned rows", (m) => entryKey("tab", m.id.c), (m) => ({ x: 60, y: frameOf(m, entryKey("tab", m.id.p1)).y + 3 })],
    ["row into the tiles", (m) => entryKey("tab", m.id.c), (m) => D.centre(frameOf(m, entryKey("tab", m.id.t2)), 0)],
    ["tile along the grid", (m) => entryKey("tab", m.id.t1), (m) => ({ x: frameOf(m, entryKey("tab", m.id.t2)).x + 70, y: 80 })],
    ["row to its own place", (m) => entryKey("tab", m.id.b), (m) => D.centre(frameOf(m, entryKey("tab", m.id.b)), -12)],
    ["row cancelled", (m) => entryKey("tab", m.id.b), (m) => ({ x: 60, y: frameOf(m, entryKey("tab", m.id.d)).y + 30 }), false],
  ];
  for (const [label, keyOf, to, commit = true] of cases) {
    const m = listScene();
    const { c, ghosts } = mount({ entries: m.L.entries, regions: m.regions });
    const { name } = labeller();
    const f = frameOf(m, keyOf(m));
    await c.begin(keyOf(m), f.x + 20, f.y + 10);
    const p = to(m);
    c.move(p.x, p.y);
    c.move(p.x, p.y + 0.5);
    const drop = name(D.readDrag(c).drop);
    animations.held = true;
    c.end(commit);
    await D.settle();
    const landing = name(D.readDrag(c).marks.landing);
    animations.held = false;
    animations.finish();
    await D.settle();
    out.push({ label, drop, landing, landed: name(c.landed), ghosts: ghostLog(ghosts, name).slice(1) });
  }
  traces.check(t, "landing cases", out);
});

test("a drag ended before its measurements arrive does nothing when they do", async (t) => {
  const m = listScene();
  const { c, ghosts } = mount({ entries: m.L.entries, regions: m.regions });
  const r = recorder(c, m.w);
  const before = D.committed(m.w);
  const b = c.items.get(entryKey("tab", m.id.b));
  b.view.held = true;
  const pending = c.begin(b.key, 40, frameOf(m, b.key).y + 10);
  r.snap("measuring");
  c.end(true);
  r.snap("ended while measuring");
  b.view.release();
  await pending;
  r.snap("measurements arrived");
  assert.deepEqual(D.committed(m.w), before);
  traces.check(t, "begin pending", [...r.steps, r.name({ ghosts: ghostLog(ghosts, r.name) })]);
});

test("a late tilesLaidOut from an old drag doesn't retarget a newer one", async (t) => {
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  const r = recorder(c, m.w);
  const b = frameOf(m, entryKey("tab", m.id.b));
  await r.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  const tiles = c.regions.get("tiles");
  tiles.held = true;
  const late = c.tilesLaidOut();
  await r.end(false);
  const a = frameOf(m, entryKey("tab", m.id.a));
  const second = r.begin(entryKey("tab", m.id.a), a.x + 20, a.y + 10);
  tiles.frame = { ...tiles.frame, y: 400 };
  tiles.release();
  await late;
  await second;
  r.snap("old tilesLaidOut arrived");
  const fresh = c.tilesLaidOut();
  await fresh;
  r.snap("own tilesLaidOut");
  r.move(60, 410);
  await r.end(false);
  traces.check(t, "tiles laid out token", r.steps);
});

test("a drag turns hover cards and Escape capture off and gives both back, however it ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  registerRow(m.w, "row", { measureInWindow: (done) => done(10, 10, 100, 30) });
  const cardShows = async () => {
    hover.rowShown(m.w, { kind: "tab", id: "row" });
    t.mock.timers.tick(800);
    await D.settle();
    const shown = sidebarUi().hover?.id === "row";
    hover.dismissHover();
    return shown;
  };
  const log = [];
  const b = frameOf(m, entryKey("tab", m.id.b));
  for (const finish of [() => c.end(true), () => c.end(false)]) {
    escapeCapture.length = 0;
    setSidebarUi({ hover: { kind: "tab", id: "x", windowId: m.w, anchor: { x: 0, y: 0, width: 1, height: 1 } } });
    await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
    const during = { card: sidebarUi().hover, shows: await cardShows(), escape: [...escapeCapture] };
    finish();
    log.push({ during, after: { shows: await cardShows(), escape: [...escapeCapture] } });
  }
  escapeCapture.length = 0;
  await c.beginExternal(1, 60, 300);
  const external = { shows: await cardShows(), escape: [...escapeCapture] };
  c.finishExternal(false);
  log.push({ external, after: { shows: await cardShows(), escape: [...escapeCapture] } });
  traces.check(t, "hover and escape", log);
});

test("committed drops survive a relaunch: tab order, pins, groups, pinned anchors and live-folder anchors", async (t) => {
  const live = await import("../../state/live/store.ts");
  const results = [];
  const cases = [
    ["row into pinned rows", (m) => entryKey("tab", m.id.c), (m) => ({ x: 60, y: m.regions.pinnedGroups.y + 2 })],
    ["pinned row to the list", (m) => entryKey("tab", m.id.p1), (m) => ({ x: 60, y: frameOf(m, entryKey("tab", m.id.c)).y + 2 })],
    ["live folder above a pinned row", (m) => entryKey("live", m.L1), (m) => ({ x: 60, y: frameOf(m, entryKey("tab", m.id.p1)).y + 2 })],
    ["group into the pinned area", (m) => entryKey("group", m.G), (m) => ({ x: 60, y: m.regions.pinnedGroups.y + 2 })],
  ];
  for (const [label, keyOf, to] of cases) {
    stub.docs.clear();
    const stop = startPersistence();
    const m = mixedScene();
    m.L1 = live.createFolder(S().windows[m.w].profileId, "pullRequests");
    const L = sceneLayout({ top: m.regions.pinnedGroups.y });
    L.live(m.L1);
    m.L.entries.push(...L.entries);
    const { c } = mount({ entries: m.L.entries, regions: m.regions });
    const r = recorder(c, m.w);
    const f = frameOf(m, keyOf(m));
    await r.begin(keyOf(m), f.x + 20, f.y + 10);
    const p = to(m);
    r.move(p.x, p.y);
    await r.end(true);
    const now = D.committed(m.w);
    flushPersistence();
    stop();
    S().hydrate(loadSession());
    const relaunched = D.committed(m.w);
    assert.deepEqual(relaunched, now, `${label}: the same after a relaunch`);
    results.push({ label, steps: r.steps });
  }
  traces.check(t, "persistence", results);
});

test("a drag begun over one that never ended stops the old one's autoscroll and hold timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions, viewport: { x: 0, y: 150, w: 200, h: 400 } });
  const b = frameOf(m, entryKey("tab", m.id.b));
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  c.scrollY = 40;
  c.move(60, 540);
  const t2 = frameOf(m, entryKey("tab", m.id.t2));
  const a = frameOf(m, entryKey("tab", m.id.a));
  await c.begin(entryKey("tab", m.id.a), a.x + 20, a.y + 10);
  const scrolled = c.scroll.scrolled.length;
  t.mock.timers.tick(1000);
  assert.equal(c.scroll.scrolled.length, scrolled, "the old drag's autoscroll is stopped");
  c.move(t2.x + t2.w / 2, t2.y + t2.h / 2);
  t.mock.timers.tick(1000);
  c.end(false);
  assert.equal(D.readDrag(c).gapKey, null);
});

test("a drag let go with no place to drop is counted; a dropped, cancelled or returned drag is not", async () => {
  const { devTabPresses } = await import("../../state/telemetry/tabPresses.ts");
  const counted = () => devTabPresses().drags_without_drop;
  const offScreen = { x: -190, y: 100, w: 200, h: 700 };
  const run = async ({ viewport, to, commit = true }) => {
    const m = listScene();
    const { c } = mount({ entries: m.L.entries, regions: m.regions, ...(viewport ? { viewport } : {}) });
    const b = frameOf(m, entryKey("tab", m.id.b));
    const before = counted();
    await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
    const p = to(m, b);
    c.move(p.x, p.y);
    const drop = D.readDrag(c).drop.type;
    c.end(commit);
    await D.settle();
    return { drop, counted: counted() - before };
  };
  const belowD = (m) => ({ x: 60, y: frameOf(m, entryKey("tab", m.id.d)).y + 30 });
  assert.deepEqual(await run({ viewport: offScreen, to: belowD }), { drop: "none", counted: 1 }, "another space's off-screen scroll view");
  assert.deepEqual(await run({ to: belowD }), { drop: "tabs", counted: 0 });
  assert.deepEqual(await run({ viewport: offScreen, to: belowD, commit: false }), { drop: "none", counted: 0 });
  assert.deepEqual((await run({ to: (m, b) => ({ x: b.x + 20, y: b.y + 12 }) })).counted, 0, "let go where it started");
});

test("a drag that starts while a fold is still filling in mounts the rest first and measures it with the other rows", async () => {
  const { fillingFold } = await import("./foldFlush.ts");
  const ran = [];
  globalThis.requestAnimationFrame = (run) => setTimeout(() => run(Date.now()), 0);
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  const late = c.create(entryKey("tab", m.id.d) + ":filled");
  Object.assign(late, { kind: "row", tabIds: [m.id.d], section: "list" });
  late.view = D.fakeView({ x: 6, y: 600, w: 180, h: 30 });
  c.windowId = "w-drag";
  const stop = fillingFold("w-drag", () => {
    ran.push("flush");
    c.items.set(late.key, late);
    stop();
  });
  const b = frameOf(m, entryKey("tab", m.id.b));
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  stop();
  assert.deepEqual(ran, ["flush"]);
  assert.deepEqual(late.frame, { x: 6, y: 600, w: 180, h: 30 }, "the drag's own pass measured the row the flush mounted");
  c.end(false);
  await D.settle();
});

test("a drag's measure keeps no frame for a row its fold hid while the measure was out", async () => {
  const { DragItems } = await import("./dragItems.ts");
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  const items = new DragItems(c, true);
  const listeners = new Set();
  let away = false;
  const folded = { away: () => away, subscribe: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const row = c.create(entryKey("tab", m.id.d) + ":folded");
  Object.assign(row, { kind: "row", tabIds: [m.id.d], section: "list" });
  row.view = D.fakeView({ x: 6, y: 600, w: 180, h: 30 });
  items.addWhileShown(row.key, row, folded);
  row.view.held = true;
  const b = frameOf(m, entryKey("tab", m.id.b));
  const begun = c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  await D.settle();
  away = true;
  for (const f of [...listeners]) f();
  away = false;
  for (const f of [...listeners]) f();
  row.view.release();
  await begun;
  assert.equal(row.frame, null, "the answer for the registration the fold took away is dropped");
  c.end(false);
  await D.settle();
});

test("a row its fold hides while the room springs open gives its gap back for good", async () => {
  const { DragItems } = await import("./dragItems.ts");
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  const items = new DragItems(c, true);
  const listeners = new Set();
  let away = false;
  const folded = { away: () => away, subscribe: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const dKey = entryKey("tab", m.id.d);
  const d = c.items.get(dKey);
  c.items.delete(dKey);
  items.addWhileShown(dKey, d, folded);
  const b = frameOf(m, entryKey("tab", m.id.b));
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  animations.held = true;
  c.move(60, frameOf(m, dKey).y + 2);
  assert.ok(c.room, "a room spring is running");
  away = true;
  for (const f of [...listeners]) f();
  animations.held = false;
  animations.finish();
  await D.settle();
  assert.equal(d.gap.__getValue(), 0);
  c.end(false);
  await D.settle();
});

test("a drag cancelled while it waits for a fold to finish doesn't go on to measure", async () => {
  const { fillingFold } = await import("./foldFlush.ts");
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  c.windowId = "w-cancel";
  const stop = fillingFold("w-cancel", () => stop());
  let measured = 0;
  const measure = c.root.measureInWindow;
  c.root.measureInWindow = (done) => (measured++, measure(done));
  const b = frameOf(m, entryKey("tab", m.id.b));
  const begun = c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  c.end(false);
  await begun;
  assert.equal(measured, 0);
  await D.settle();
});

test("R5-S1: a selected tab that a flush mounts joins the drag it starts", async () => {
  const { fillingFold } = await import("./foldFlush.ts");
  globalThis.requestAnimationFrame = (run) => setTimeout(() => run(Date.now()), 0);
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  c.windowId = "w-select";
  const dKey = entryKey("tab", m.id.d);
  const d = c.items.get(dKey);
  c.items.delete(dKey);
  const stop = fillingFold("w-select", () => {
    c.items.set(dKey, d);
    stop();
  });
  S().setSelection(m.w, [m.id.b, m.id.d]);
  const b = frameOf(m, entryKey("tab", m.id.b));
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  assert.deepEqual(c.session.sources.map((s) => s.key).sort(), [entryKey("tab", m.id.b), dKey].sort());
  assert.equal(c.session.ghost.count, 2);
  c.end(false);
  S().setSelection(m.w, []);
  await D.settle();
});

test("R5-S4: an older measuring pass that lands after a newer one keeps none of its frames", async () => {
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  const dKey = entryKey("tab", m.id.d);
  const d = c.items.get(dKey);
  const calls = [];
  let next = 600;
  d.view = { measureInWindow: (done) => calls.push({ done, y: next }) };
  const b = frameOf(m, entryKey("tab", m.id.b));
  const begun = c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  await D.settle();
  next = 900;
  const again = c.remeasure(c.session);
  await D.settle();
  calls[1].done(6, calls[1].y, 180, 30);
  await again;
  calls[0].done(6, calls[0].y, 180, 30);
  await begun;
  assert.equal(d.frame.y, 900);
  c.end(false);
  await D.settle();
});

test("R5-S5: a landing measured for a row its fold withdrew meanwhile is dropped", async () => {
  const m = listScene();
  const { c } = mount({ entries: m.L.entries, regions: m.regions });
  const b = frameOf(m, entryKey("tab", m.id.b));
  await c.begin(entryKey("tab", m.id.b), b.x + 20, b.y + 10);
  c.move(60, frameOf(m, entryKey("tab", m.id.d)).y + 2);
  const ref = c.items.get(c.session.gapKey);
  assert.ok(ref, "the drag opened a gap at a row");
  ref.view.held = true;
  const spot = c.landingSpot(c.session.drop);
  c.items.delete(ref.key);
  ref.held = (ref.held ?? 0) + 1;
  ref.view.release();
  assert.equal(await spot, null);
  c.items.set(ref.key, ref);
  c.end(false);
  await D.settle();
});
