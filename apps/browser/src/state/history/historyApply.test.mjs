import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { applyHistoryChanges } = await import("./engineSync.ts");
const { MAX_HISTORY, MAX_VISIT_TIMES } = await import("./history.ts");
const { isWebPageUrl } = await import("../../lib/url.ts");
const urlsOf = (change) => (change.kind === "visit" ? [change.url] : change.kind === "modified" ? change.rows.map((r) => r.url) : change.urls);

function referenceApply(list, changes, note) {
  const wanted = new Set(changes.flatMap(urlsOf));
  const touched = new Map();
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    if (wanted.has(h.url) && !touched.has(h.url)) touched.set(h.url, { entry: h, index: i, moved: false, seq: 0 });
  }
  const stateOf = (url) => {
    let state = touched.get(url);
    if (!state) touched.set(url, (state = { entry: undefined, index: -1, moved: false, seq: 0 }));
    return state;
  };
  let seq = 0;
  let dirty = false;
  for (const change of changes) {
    switch (change.kind) {
      case "visit": {
        if (!isWebPageUrl(change.url)) break;
        const state = stateOf(change.url);
        const old = state.entry;
        if (old?.visitTimes?.includes(change.at)) break;
        const times = [...(old?.visitTimes ?? []), change.at].sort((a, b) => a - b).slice(-MAX_VISIT_TIMES);
        state.entry = {
          url: change.url,
          title: change.title || old?.title || "",
          favicon: null,
          visits: Math.max(change.visits, 1),
          lastVisit: times[times.length - 1],
          visitTimes: times,
        };
        if (!state.entry.title) note?.("visit-untitled");
        state.moved = true;
        state.seq = ++seq;
        dirty = true;
        break;
      }
      case "modified": {
        for (const row of new Map(change.rows.map((r) => [r.url, r])).values()) {
          const state = touched.get(row.url);
          const h = state?.entry;
          if (!h && isWebPageUrl(row.url)) note?.("modified-unknown");
          if (!state || !h || ((row.title === h.title || !row.title) && row.visits === h.visits)) continue;
          state.entry = { ...h, title: row.title || h.title, visits: row.visits };
          dirty = true;
        }
        break;
      }
      case "deleted": {
        for (const url of change.urls) {
          const state = touched.get(url);
          if (!state?.entry) continue;
          state.entry = undefined;
          dirty = true;
        }
        break;
      }
    }
  }
  if (!dirty) return list;

  const slots = list.slice();
  const moved = [];
  for (const state of touched.values()) {
    if (state.moved && state.entry) moved.push(state);
    if (state.index >= 0) slots[state.index] = state.moved ? null : (state.entry ?? null);
  }
  moved.sort((a, b) => b.entry.lastVisit - a.entry.lastVisit || b.seq - a.seq);
  const next = [];
  let m = 0;
  for (const h of slots) {
    if (!h) continue;
    while (m < moved.length && moved[m].entry.lastVisit >= h.lastVisit) next.push(moved[m++].entry);
    next.push(h);
  }
  while (m < moved.length) next.push(moved[m++].entry);
  if (next.length > MAX_HISTORY) next.length = MAX_HISTORY;
  return next;
}

function rng(seed) {
  let x = seed >>> 0 || 1;
  return (n) => ((x = (x * 1103515245 + 12345) >>> 0) % n);
}

function listOf(r, n) {
  const list = [];
  let t = 2_000_000;
  for (let i = 0; i < n; i++) {
    t -= r(3);
    const times = [t - 500, t].slice(r(2));
    const site = r(25) ? i : r(i + 1);
    list.push({ url: `https://s${site}.example/`, title: `T${i}`, favicon: null, visits: 1 + r(5), lastVisit: t, visitTimes: times });
  }
  return list;
}

function changesOf(r, n, at) {
  const url = () => (r(4) ? `https://s${r(n + 20)}.example/` : r(2) ? `chrome://x${r(9)}` : `https://new${r(30)}.example/`);
  return Array.from({ length: 1 + r(6) }, () => {
    const k = r(3);
    if (k === 0) return { kind: "visit", profile: "", url: url(), title: r(3) ? `V${r(99)}` : "", visits: r(4), at: at + r(4) * 100 - 150 };
    if (k === 1) return { kind: "modified", profile: "", rows: Array.from({ length: 1 + r(3) }, () => ({ url: url(), title: r(2) ? `M${r(9)}` : "", visits: r(6) })) };
    return { kind: "deleted", profile: "", all: false, urls: Array.from({ length: 1 + r(3) }, url) };
  });
}

test("one pass over the list gives exactly the list the two-copy merge gave, over random lists and batches, at and past the cap", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const n = seed % 50 === 0 ? MAX_HISTORY : 1 + r(120);
    let list = listOf(r, n);
    let notesA = [], notesB = [];
    for (let step = 0; step < 6; step++) {
      const changes = changesOf(r, n, 2_000_000 - r(n * 2) + step);
      const want = referenceApply(list, changes, (g) => notesA.push(g));
      const got = applyHistoryChanges(list, changes, (g) => notesB.push(g));
      assert.deepEqual(got, want, `seed ${seed} step ${step}`);
      assert.equal(got === list, want === list, `seed ${seed} step ${step}: unchanged lists are returned as they were`);
      assert.deepEqual(notesB, notesA);
      list = got;
    }
  }
});
