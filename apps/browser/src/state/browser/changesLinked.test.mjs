import assert from "node:assert/strict";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

globalThis.__DEV__ = false;
const { changedIds, keyOrderBase, linkChanges, linkEdits, linkedChangedIds, scannedChangedIds, withEntry, withoutEntries, LINKS_KEPT } = await import("./changes.ts");

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sorted = (ids) => [...ids].sort();

function assertSameAsScan(next, prev, where) {
  const scanned = scannedChangedIds(next, prev);
  assert.equal(new Set(scanned).size, scanned.length, `${where}: the scan lists each id once`);
  const linked = linkedChangedIds(next, prev);
  if (linked) assert.deepEqual([...linked], [...scanned], `${where}: linked, in the scan's order`);
  assert.deepEqual([...changedIds(next, prev)], [...scanned], `${where}: changedIds, in the scan's order`);
  return !!linked;
}

function mutate(rand, prev, ids) {
  const pick = () => ids[Math.floor(rand() * ids.length)];
  const roll = rand();
  if (roll < 0.35) return withEntry(prev, pick(), rand() < 0.15 && prev[ids[0]] ? prev[ids[0]] : { v: rand() });
  if (roll < 0.45) {
    const id = pick();
    return prev[id] ? withEntry(prev, id, prev[id]) : withEntry(prev, id, { v: rand() });
  }
  if (roll < 0.6) return withoutEntries(prev, Array.from({ length: 1 + Math.floor(rand() * 3) }, pick));
  if (roll < 0.68) return withoutEntries(prev, new Set([pick(), "never-there"]));
  if (roll < 0.74) {
    const draft = { ...prev };
    const touched = [];
    for (let k = Math.floor(rand() * 4); k >= 0; k--) {
      const id = pick();
      if (rand() < 0.3) delete draft[id];
      else draft[id] = { v: rand() };
      touched.push(id);
    }
    if (rand() < 0.3) touched.push("never-there", touched[0]);
    return linkChanges(draft, prev, touched);
  }
  if (roll < 0.8) {
    const draft = { ...prev };
    const touched = Object.keys(prev).filter(() => rand() < 0.2);
    for (const id of touched) draft[id] = { v: rand() };
    if (rand() < 0.3) touched.push("never-there");
    return linkEdits(draft, prev, touched);
  }
  if (roll < 0.9) {
    const draft = { ...prev };
    draft[pick()] = { v: rand() };
    if (rand() < 0.5) delete draft[pick()];
    return draft;
  }
  if (roll < 0.95) return prev;
  return Object.fromEntries(Object.entries(prev).reverse());
}

test("on random edit sequences the linked answer always equals the full scan, for every pair of records", () => {
  let linkedPairs = 0;
  let pairs = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rand = random(seed);
    const ids = Array.from({ length: 4 + Math.floor(rand() * 40) }, (_, i) => (i % 9 === 4 ? String(i) : `t${i}`));
    const first = Object.fromEntries(ids.filter(() => rand() < 0.7).map((id) => [id, { v: rand() }]));
    const history = [first];
    for (let step = 0; step < 45; step++) {
      const from = rand() < 0.2 ? history[Math.floor(rand() * history.length)] : history.at(-1);
      const made = mutate(rand, from, ids);
      history.push(made);
      for (let back = 1; back <= 3 && back < history.length; back++) {
        pairs++;
        if (assertSameAsScan(made, history.at(-1 - back), `seed ${seed} step ${step} back ${back}`)) linkedPairs++;
      }
    }
    for (let j = 0; j < history.length; j++) {
      for (let i = 0; i < history.length; i++) {
        pairs++;
        if (assertSameAsScan(history[j], history[i], `seed ${seed} pair ${i}→${j}`)) linkedPairs++;
      }
    }
  }
  assert.ok(linkedPairs > pairs / 20, `the links answer a real share of pairs (${linkedPairs} of ${pairs})`);
});

test("a chain answers up to its kept length and falls back to the scan past it", () => {
  let record = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`t${i}`, { v: i }]));
  const history = [record];
  for (let i = 0; i < LINKS_KEPT + 3; i++) history.push((record = withEntry(record, `t${i % 5}`, { v: -i })));
  const newest = history.at(-1);
  for (let back = 1; back < history.length; back++) {
    const prev = history.at(-1 - back);
    const linked = linkedChangedIds(newest, prev);
    if (back <= LINKS_KEPT) assert.ok(linked, `${back} steps back is linked`);
    else assert.equal(linked, null, `${back} steps back is past the chain`);
    assertSameAsScan(newest, prev, `${back} back`);
  }
});

test("a record unlinked from its parent, or a parent edited in place, gets the full scan", () => {
  const prev = { a: { v: 1 }, b: { v: 2 } };
  const copy = { ...prev, c: { v: 3 } };
  assert.equal(linkedChangedIds(copy, prev), null);
  assert.deepEqual(changedIds(copy, prev), ["c"]);
  const next = withEntry(prev, "a", { v: 9 });
  const unrelated = { a: { v: 1 } };
  assert.equal(linkedChangedIds(next, unrelated), null);
  assertSameAsScan(next, unrelated, "unrelated");
});

test("the store's tab changes match the full scan through random actions, transactions included", async () => {
  const { useBrowser, storeTransaction } = await import("./store.ts");
  const { watchTab } = await import("../tabs/tabWatch.ts");
  const S = () => useBrowser.getState();
  let linked = 0;
  let notified = 0;
  let wakeMismatch = null;
  const woke = new Set();
  const watched = new Map();
  const expected = new Set();
  const off = useBrowser.subscribe((s, prev) => {
    if (s.tabs === prev.tabs) return;
    notified++;
    for (const id of watched.keys()) if (s.tabs[id] !== prev.tabs[id]) expected.add(id);
    if (assertSameAsScan(s.tabs, prev.tabs, `notification ${notified}`)) linked++;
  });
  const check = () => {
    if (!wakeMismatch && sorted(woke).join() !== sorted(expected).join()) wakeMismatch = { woke: sorted(woke), expected: sorted(expected) };
    woke.clear();
    expected.clear();
  };
  for (let seed = 1; seed <= 6; seed++) {
    const rand = random(1000 + seed);
    S().hydrate({});
    const w = S().createWindow({ url: "https://a.com" });
    for (let i = 0; i < 30; i++) S().newTab(w, { url: `https://site${i}.com/${i}`, background: rand() < 0.6 });
    for (const [, stop] of watched) stop();
    watched.clear();
    for (const id of Object.keys(S().tabs)) if (rand() < 0.5) watched.set(id, watchTab(id, () => woke.add(id)));
    woke.clear();
    expected.clear();
    const live = () => Object.keys(S().tabs);
    const pick = () => live()[Math.floor(rand() * live().length)];
    const action = () => {
      const roll = rand();
      const id = pick();
      if (!id) return;
      if (roll < 0.3) S().updateTab(id, { title: `T${rand()}` });
      else if (roll < 0.45) S().activate(id);
      else if (roll < 0.55) S().newTab(w, { url: `https://n${Math.floor(rand() * 1e6)}.com`, background: rand() < 0.5, openerId: rand() < 0.5 ? id : undefined });
      else if (roll < 0.65 && live().length > 3) S().closeTab(id);
      else if (roll < 0.75) S().navigate(id, `https://go${Math.floor(rand() * 1e6)}.com`);
      else if (roll < 0.82) S().togglePin(id);
      else if (roll < 0.88) S().duplicateTab(id);
      else if (roll < 0.92) S().updateTab(id, { muted: rand() < 0.5 });
      else S().closeTabs([id, pick()].filter(Boolean), { lastClosesWindow: false });
    };
    for (let step = 0; step < 120; step++) {
      if (rand() < 0.3) storeTransaction(() => {
        for (let k = 1 + Math.floor(rand() * 4); k > 0; k--) action();
      });
      else action();
      check();
    }
  }
  off();
  for (const [, stop] of watched) stop();
  assert.equal(wakeMismatch, null, "tab watchers wake for exactly the tabs that changed");
  assert.ok(notified > 300, `the actions changed tabs (${notified} notifications)`);
  assert.ok(linked > notified / 2, `most store notifications skip the scan (${linked} of ${notified})`);
});

test("the everyday tab actions on a big profile never compare every tab, and are counted only while sharing is on", async () => {
  const { useBrowser } = await import("./store.ts");
  const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
  const { changeDetection, takeChangeDetectionCounts } = await import("./changes.ts");
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const ids = Array.from({ length: 300 }, (_, i) => S().newTab(w, { url: `https://site${i}.com`, background: true }));
  const heard = [];
  const off = useBrowser.subscribe((s, prev) => s.tabs !== prev.tabs && heard.push(changedIds(s.tabs, prev.tabs)));
  takeChangeDetectionCounts();
  S().updateTab(ids[7], { title: "unshared" });
  assert.deepEqual(takeChangeDetectionCounts(), { record_changes_linked: 0, record_changes_scanned: 0, record_changes_scanned_entries: 0 }, "nothing counted without consent");
  setConsentPeriod(true, "changes-linked-test");
  try {
    S().updateTab(ids[7], { title: "T7" });
    S().activate(ids[40]);
    S().newTab(w, { url: "https://new.com", background: true, openerId: ids[40] });
    S().newTab(w, { url: "https://front.com" });
    S().closeTab(ids[41]);
    S().navigate(ids[42], "https://elsewhere.com");
    S().togglePin(ids[43]);
    S().openPeek(ids[40], "https://peek.com");
    assert.ok(changeDetection.scannedEntries <= changeDetection.scanned * 5, `no scan compared the tabs, only the window record (${changeDetection.scannedEntries} entries in ${changeDetection.scanned} scans)`);
    assert.ok(changeDetection.linked >= 8, `each action was answered from its links (${changeDetection.linked})`);
    assert.ok(heard.every((ids) => ids.length < 10), "each notification names only the tabs it changed");
  } finally {
    setConsentPeriod(false, null);
    off();
  }
});

test("a record edited after it was made, like a bookmark delete rewriting the parent folder, still lists every change", async () => {
  const { removeBookmarkTree } = await import("../bookmarks/bookmarks.ts");
  const tree = { nodes: { root: { id: "root", kind: "folder", children: ["leaf", "keep"] }, leaf: { id: "leaf", kind: "url" }, keep: { id: "keep", kind: "url" } } };
  const after = removeBookmarkTree(tree, ["leaf"]);
  assert.deepEqual(changedIds(after.nodes, tree.nodes), ["root", "leaf"], "the parent folder lost a child, and the leaf went");
});

test("two copies of a pin that wake in one batch hand the page to the same copy as the full scan did", async () => {
  const { useBrowser, storeTransaction } = await import("./store.ts");
  const model = await import("./model.ts");
  const { wokenPage } = await import("../tabs/pageSession.ts");
  const S = () => useBrowser.getState();
  const realNow = Date.now;
  Date.now = () => 1000;
  try {
    S().hydrate({});
    const a = S().createWindow({ url: "https://mail.com" });
    const [mail] = S().windows[a].tabIds;
    S().newTab(a, { url: "https://a.com" });
    S().pinTabs([mail], true);
    const b = S().createWindow({ url: "https://b.com" });
    const copy = model.viewTabIds(S(), b).find((id) => !!S().tabs[id].pin);
    S().closeTabs([mail], { lastClosesWindow: false });
    assert.ok(Object.keys(S().tabs).indexOf(mail) < Object.keys(S().tabs).indexOf(copy), "the first copy comes first in the tabs record");
    storeTransaction(() => {
      S().updateTab(copy, { page: wokenPage(S().tabs[copy]) });
      S().updateTab(mail, { page: wokenPage(S().tabs[mail]) });
    });
    assert.equal(S().tabs[copy].page.kind, "loaded", "the copy keeps the page, as with the full scan's order");
    assert.equal(S().tabs[mail].page.holderId, copy, "the first copy shows it frozen");
  } finally {
    Date.now = realNow;
  }
});

test("a raw draft that deletes and reinserts a key gets the scan's order, not the key's old place", () => {
  const first = { a: { v: 1 }, b: { v: 2 }, c: { v: 3 } };
  const ordered = withEntry(withEntry(first, "c", { v: 9 }), "b", { v: 7 });
  assert.deepEqual(changedIds(ordered, first), ["b", "c"]);
  const draft = { ...ordered };
  delete draft.a;
  draft.a = { v: 5 };
  draft.b = { v: 6 };
  linkChanges(draft, ordered, ["a", "b"]);
  assert.deepEqual(linkedChangedIds(draft, ordered), ["b", "a"], "a moved to the end when it was reinserted");
});

test("shrinking a big record lets its key order go, so the live record doesn't keep the big map", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc");
  const shrink = () => {
    const big = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`k${i}`, { v: i }]));
    const edited = withEntry(withEntry(big, "k1", { v: -1 }), "k2", { v: -2 });
    assert.deepEqual(changedIds(edited, big), ["k1", "k2"]);
    const base = keyOrderBase(edited);
    assert.equal(base?.size, 10000, "the edits share the big record's key order");
    let small = withoutEntries(edited, Array.from({ length: 9998 }, (_, i) => `k${i + 2}`));
    for (let i = 0; i < 128; i++) small = withoutEntries(withEntry(small, `n${i}`, { v: i }), [`n${i}`]);
    assert.notEqual(keyOrderBase(small), base, "the small record no longer carries the big map");
    return { base: new WeakRef(base), small };
  };
  const { base, small } = shrink();
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  assert.equal(base.deref(), undefined, "the big map is released");
  assert.deepEqual(Object.keys(small), ["k0", "k1"]);
  assert.deepEqual(changedIds(withEntry(withEntry(small, "k1", { v: 0 }), "k0", { v: 0 }), small), ["k0", "k1"]);
});

test("a removal that lists one id several times counts it once toward letting the key order go", () => {
  const first = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, { v: i }]));
  const ordered = withEntry(withEntry(first, "k1", { v: -1 }), "k2", { v: -2 });
  assert.deepEqual(changedIds(ordered, first), ["k1", "k2"]);
  const base = keyOrderBase(ordered);
  const removed = withoutEntries(ordered, ["k3", "k3", "k3", "k3", "k3", "k3"]);
  assert.equal(keyOrderBase(removed), base, "one real deletion of ten keeps the inherited order");
  assert.deepEqual(changedIds(removed, ordered), ["k3"]);
});
