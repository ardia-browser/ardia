import assert from "node:assert/strict";
import { test } from "node:test";
const { shellNativeModules } = await import("../../test-native/index.ts");
globalThis.requestAnimationFrame ??= (run) => setImmediate(run);
const D = await import("./fixtures/dragScene.mjs");
const { world, regionsOf } = await import("./fixtures/dragWorld.mjs");
const { DragItems } = await import("./dragItems.ts");
const { devTabPresses } = await import("../../state/telemetry/tabPresses.ts");
const { S, entryKey, sceneLayout, mount, readDrag, fakeView, settle, gaps } = D;

const host = (tabId) => new URL(S().tabs[tabId].url).hostname.split(".")[0];
const remeasured = async () => {
  for (let i = 0; i < 4; i++) await settle();
};

function twoPages() {
  const { w, id } = world("a", "b", "c");
  const home = S().windows[w].profileId;
  const work = S().createProfile({ name: "Work" });
  S().updateSettings({ warnBeforeMovingTabsToProfile: false });
  for (const h of ["x", "y", "z"]) id[h] = S().newTab(w, { url: `https://${h}.com/`, background: true, profileId: work });
  const G = S().groupTabs([id.c], { name: "G" });
  const lay = (build) => {
    const L = sceneLayout({ top: 150 });
    build(L);
    return L;
  };
  const A = lay((L) => L.group(G, {}, (m) => L.row(id.c, m)).row(id.a).row(id.b).tail("list"));
  const B = lay((L) => L.row(id.x).row(id.y).tail("list"));
  const { c, ghosts } = mount({ entries: [], regions: regionsOf(A, { list: [150, A.y] }) });
  c.showPage(home);
  const views = new Map();
  const itemOf = (e) => {
    views.set(e.key, fakeView(e.frame));
    return Object.assign(c.create(e.key), e.spec, { view: views.get(e.key), header: e.header ? fakeView(e.header) : null });
  };
  const pages = { [home]: new DragItems(c, true), [work]: new DragItems(c, false) };
  for (const e of A.entries) pages[home].add(e.key, itemOf(e));
  for (const e of B.entries) pages[work].add(e.key, itemOf(e));
  const turnTo = (profileId) => {
    const from = S().windows[w].profileId;
    S().switchProfile(w, profileId);
    pages[from].setLive(false);
    pages[profileId].setLive(true);
    c.showPage(profileId);
  };
  const frame = (L, tabId) => L.entries.find((e) => e.key === entryKey("tab", tabId)).frame;
  const lateRow = (tabId, y) => pages[work].add(entryKey("tab", tabId), itemOf({ key: entryKey("tab", tabId), spec: { kind: "row", tabIds: [tabId], section: "list" }, frame: { ...frame(B, id.x), y } }));
  const order = (profileId) => S().windows[w].tabIds.filter((t) => S().tabs[t].profileId === profileId).map(host);
  const view = (key) => views.get(key);
  return { w, id, home, work, G, A, B, c, ghosts, turnTo, frame, lateRow, order, view };
}

test("a row dragged while the sidebar turns to another space finds that space's rows and lands among them, in its profile", async () => {
  const m = twoPages();
  const { c, id } = m;
  const from = m.frame(m.A, id.a);
  await c.begin(entryKey("tab", id.a), from.x + 20, from.y + 10);
  c.move(from.x + 22, m.frame(m.A, id.b).y + 2);
  assert.equal(readDrag(c).drop.type, "tabs", "at home the drag has a place");

  m.turnTo(m.work);
  const ghost = m.ghosts.at(-1);
  c.move(from.x + 30, from.y + 90);
  assert.equal(readDrag(c).drop.type, "none", "nothing is targeted from the old space's measurements");
  assert.equal(ghost.position.y.__getValue(), from.y + 90 - 10, "the ghost keeps following while the new rows are measured");
  await remeasured();

  const y = m.frame(m.B, id.y);
  c.move(from.x + 30, y.y + 4);
  assert.deepEqual(readDrag(c).drop, { type: "tabs", placement: { pinned: false, beforeId: id.y }, sequence: [] });
  assert.deepEqual(Object.keys(gaps(c)), [entryKey("tab", id.y)], "the gap opens in the space on screen");

  const before = devTabPresses().drags_to_other_profile;
  c.end(true);
  await settle();
  assert.deepEqual(m.order(m.work), ["x", "a", "y", "z"]);
  assert.deepEqual(m.order(m.home), ["c", "b"]);
  assert.equal(S().windows[m.w].profileId, m.work, "the window stays on the space the tab was dropped in");
  assert.equal(S().windows[m.w].activeTabIds[m.work], id.a, "and shows the tab");
  assert.equal(devTabPresses().drags_to_other_profile, before + 1);
});

test("turned back to its own space before the drop, a row is only reordered", async () => {
  const m = twoPages();
  const { c, id } = m;
  const from = m.frame(m.A, id.a);
  await c.begin(entryKey("tab", id.a), from.x + 20, from.y + 10);
  m.turnTo(m.work);
  await remeasured();
  m.turnTo(m.home);
  await remeasured();
  const before = devTabPresses().drags_to_other_profile;
  c.move(from.x + 30, 900);
  assert.deepEqual(readDrag(c).drop.placement, { pinned: false, beforeId: null });
  c.end(true);
  await settle();
  assert.deepEqual(m.order(m.home), ["c", "b", "a"]);
  assert.deepEqual(m.order(m.work), ["x", "y", "z"]);
  assert.equal(devTabPresses().drags_to_other_profile, before);
});

test("a group has no place in another space, and a drop there leaves everything where it was", async () => {
  const m = twoPages();
  const { c, id } = m;
  const key = entryKey("group", m.G);
  const from = m.A.entries.find((e) => e.key === key).frame;
  await c.begin(key, from.x + 20, from.y + 10);
  m.turnTo(m.work);
  await remeasured();
  c.move(from.x + 30, m.frame(m.B, id.y).y + 4);
  assert.equal(readDrag(c).drop.type, "none");
  assert.deepEqual(gaps(c), {}, "no gap offers a place");
  c.end(true);
  await settle();
  assert.deepEqual(m.order(m.home), ["c", "a", "b"]);
  assert.deepEqual(S().groups[m.G].tabIds, [id.c]);
});

test("a row that mounts after the turn is measured too, and takes drops", async () => {
  const m = twoPages();
  const { c, id } = m;
  const from = m.frame(m.A, id.a);
  await c.begin(entryKey("tab", id.a), from.x + 20, from.y + 10);
  m.turnTo(m.work);
  await remeasured();
  const tail = m.B.entries.find((e) => e.key === "tail:list");
  const late = tail.frame.y + 4;
  tail.frame.y += 37;
  m.lateRow(id.z, late);
  await remeasured();
  c.move(from.x + 30, late + 2);
  assert.equal(readDrag(c).drop.placement.beforeId, id.z);
});

test("the space turning before the first measurements arrive doesn't leave the drag targeting the old space", async () => {
  const m = twoPages();
  const { c, id } = m;
  const from = m.frame(m.A, id.a);
  c.root.held = true;
  const begun = c.begin(entryKey("tab", id.a), from.x + 20, from.y + 10);
  m.turnTo(m.work);
  c.root.release();
  await begun;
  await remeasured();
  c.move(from.x + 30, m.frame(m.B, id.y).y + 4);
  assert.equal(readDrag(c).drop.placement.beforeId, id.y);
  c.end(false);
  assert.deepEqual(m.order(m.home), ["c", "a", "b"]);
});

test("measurements a newer page turn has overtaken change nothing when they come in", async () => {
  const m = twoPages();
  const { c, id } = m;
  const from = m.frame(m.A, id.a);
  await c.begin(entryKey("tab", id.a), from.x + 20, from.y + 10);
  const slow = m.view(entryKey("tab", id.y));
  const real = slow.frame;
  slow.held = true;
  m.turnTo(m.work);
  await remeasured();
  m.lateRow(id.z, m.B.entries.find((e) => e.key === "tail:list").frame.y + 4);
  await remeasured();
  const [overtaken, current] = slow.pending;
  assert.ok(overtaken && current, "both measurements are waiting on the same row");
  slow.pending = [];
  slow.held = false;
  current();
  await remeasured();
  c.move(from.x + 30, real.y + 4);
  assert.equal(readDrag(c).drop.placement.beforeId, id.y);
  slow.frame = { ...real, y: real.y + 500 };
  overtaken();
  slow.frame = real;
  await remeasured();
  c.move(from.x + 31, real.y + 4);
  assert.equal(readDrag(c).drop.placement.beforeId, id.y, "the row is still where the newer measurement found it");
});

test("with the move warning on, the tab moves only once it is confirmed, and no ghost lands before the answer", async () => {
  const dialogs = shellNativeModules.ArdiaDialogs;
  const original = dialogs.confirm;
  let answer;
  const asked = [];
  dialogs.confirm = (options) => (asked.push(options.title), new Promise((resolve) => (answer = (confirmed) => resolve({ confirmed, suppressed: false }))));
  try {
    for (const confirmed of [false, true]) {
      const m = twoPages();
      const { c, id } = m;
      S().updateSettings({ warnBeforeMovingTabsToProfile: true });
      const from = m.frame(m.A, id.a);
      await c.begin(entryKey("tab", id.a), from.x + 20, from.y + 10);
      m.turnTo(m.work);
      await remeasured();
      c.move(from.x + 30, m.frame(m.B, id.y).y + 4);
      c.end(true);
      await settle();
      assert.equal(asked.at(-1), "Move Tab to Profile?");
      assert.equal(m.ghosts.at(-1), null, "the ghost is gone, not landing");
      assert.equal(readDrag(c).marks.landing, null);
      assert.deepEqual(m.order(m.work), ["x", "y", "z"], "nothing moves before the answer");
      answer(confirmed);
      await settle();
      assert.deepEqual(m.order(m.work), confirmed ? ["x", "a", "y", "z"] : ["x", "y", "z"]);
      assert.deepEqual(m.order(m.home), confirmed ? ["c", "b"] : ["c", "a", "b"]);
    }
  } finally {
    dialogs.confirm = original;
  }
});

test("without the warning, the ghost lands where the tab was dropped in the other space", async () => {
  const m = twoPages();
  const { c, id } = m;
  const from = m.frame(m.A, id.a);
  await c.begin(entryKey("tab", id.a), from.x + 20, from.y + 10);
  m.turnTo(m.work);
  await remeasured();
  c.move(from.x + 30, m.frame(m.B, id.y).y + 4);
  c.end(true);
  assert.equal(S().tabs[id.a].profileId, m.work, "the tab has moved by the time the drag ends");
  assert.equal(m.ghosts.at(-1)?.landing, true);
  assert.equal(readDrag(c).marks.landing, entryKey("tab", id.a));
});
