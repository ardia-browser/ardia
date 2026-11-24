import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const adapters = await import("./historyAdapter.ts");
const { historyExtractsOf } = await import("./historyExtracts.ts");
const { isWebPageUrl } = await import("../../lib/url.ts");
const stub = await import("../../test-native/index.ts");

const DAY = 86_400_000;
const WINDOW = 90 * DAY;

function rng(seed) {
  let x = seed >>> 0 || 1;
  return (n) => ((x = (x * 1103515245 + 12345) >>> 0) % n);
}

const SAME_VISIT_MS = 1;
const sameVisits = (a, b) => a.length === b.length && a.every((t, i) => Math.abs(b[i] - t) <= SAME_VISIT_MS);

function referenceExtract(view, since, floor, baseOf) {
  const web = isWebPageUrl;
  const values = new Map();
  const older = new Set();
  for (const e of view) {
    if (!web(e.url)) continue;
    const key = `h:${e.url}`;
    if (e.lastVisit < since) {
      older.add(key);
      continue;
    }
    const local = { t: e.title, n: e.visits, vt: e.visitTimes?.length ? e.visitTimes : [e.lastVisit] };
    const known = baseOf(key) ?? null;
    const edited = !known || (!sameVisits(local.vt, known.vt) && local.vt.some((t) => !known.vt.some((k) => Math.abs(k - t) <= SAME_VISIT_MS)));
    values.set(key, edited ? local : known);
  }
  const ignore = (key) => {
    if (older.has(key) || !web(key.slice(2))) return true;
    const known = baseOf(key);
    const last = known ? Math.max(...known.vt) : undefined;
    return last !== undefined && (last < since || last <= floor);
  };
  return { values, ignore };
}

function viewOf(r, now, sorted) {
  const n = 1 + r(400);
  const list = Array.from({ length: n }, (_, i) => {
    const lastVisit = now - r(2) * r(200) * DAY - r(DAY);
    const url = r(15) ? `${r(6) ? "https" : r(2) ? "HTTP" : "file"}://p${r(n + 40)}.example/${i % 3}` : `chrome://flags/${i}`;
    return { url, title: `T${i}`, favicon: null, visits: 1, lastVisit, visitTimes: [lastVisit] };
  });
  return sorted ? list.sort((a, b) => b.lastVisit - a.lastVisit) : list;
}

test("the window walk stops at 90 days on a newest-first list and answers ignore exactly as the full walk did, sorted or not, duplicates included", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const now = Date.now();
    const view = viewOf(r, now, seed % 5 !== 0);
    const floor = r(3) ? -Infinity : now - r(150) * DAY;
    const base = new Map();
    for (let i = 0; i < 30; i++) {
      const row = view[r(view.length)];
      const url = r(4) ? row.url : `https://p${r(900)}.example/x`;
      const t = now - r(200) * DAY;
      base.set(`h:${url}`, r(3) ? { t: "B", n: 1, vt: [t] } : { t: "B", n: 7, vt: [...row.visitTimes] });
    }
    const baseOf = (key) => base.get(key);
    useBrowser.getState().hydrate({});
    useBrowser.setState({ history: { "": { list: view, floor, ready: true } } });
    const got = adapters.historyAdapter("default").extract(baseOf, () => false, now, () => true, () => undefined, () => undefined, (key) => (base.has(key) ? JSON.stringify(base.get(key)) : undefined));
    const want = referenceExtract(view, Date.now() - WINDOW, floor, baseOf);
    assert.deepEqual(got.values, want.values, `seed ${seed}: values and their payloads`);
    const keys = new Set([...view.map((e) => `h:${e.url}`), ...base.keys(), "h:https://never.example/", "h:chrome://x"]);
    for (const key of keys) assert.equal(got.ignore(key), want.ignore(key), `seed ${seed}: ignore ${key}`);
  }
});

test("an old local row is ignored before its synced JSON is read: a malformed one doesn't throw, and nothing old is parsed or cached", () => {
  const now = Date.now();
  const old = now - 100 * DAY;
  const url = "https://old.example/";
  useBrowser.getState().hydrate({});
  useBrowser.setState({ history: { "": { list: [{ url, title: "Old", favicon: null, visits: 1, lastVisit: old, visitTimes: [old] }], floor: -Infinity, ready: true } } });
  const cached = historyExtractsOf("default").parsed;
  const before = cached.size;
  const { ignore } = adapters.historyAdapter("default").extract(() => undefined, () => false, now, () => true, () => undefined, () => undefined, (key) => (key === `h:${url}` ? "{" : undefined));
  assert.equal(ignore(`h:${url}`), true);
  assert.equal(cached.size, before);
});

test("a synced history record with 200,000 visit times, from a damaged or foreign file, is read as expired or kept without overflowing, and applied as its newest 50", async () => {
  const now = Date.now();
  const recent = Array.from({ length: 200_000 }, (_, i) => now - DAY + 2 * i);
  const old = recent.map((t) => t - 120 * DAY);
  assert.equal(adapters.historyExpired("h:https://long.example/", { t: "Long", n: recent.length, vt: recent }, now), false);
  assert.equal(adapters.historyExpired("h:https://long.example/", { t: "Long", n: old.length, vt: old }, now), true);
  useBrowser.setState({ history: { "": { list: [], floor: -Infinity, ready: true } } });
  const many = recent.slice(-1_000).reverse();
  const view = new Map([["h:https://long.example/", { t: "Long", n: many.length, vt: many }]]);
  await adapters.historyAdapter("default").apply(view, new Set(view.keys()), () => undefined, { known: () => true, now, horizon: 0, joined: true });
  assert.deepEqual(stub.chromeHistory("").get("https://long.example/").visits, recent.slice(-50), "only the newest 50 times reach the engine");
});

test("a synced record holding one time many times over still lands its other times", async () => {
  const now = Date.now();
  const url = "https://repeat.example/";
  const older = Array.from({ length: 49 }, (_, i) => now - 3 * DAY + i * 60_000);
  const repeated = now - 2 * DAY;
  const vt = [...older, ...Array.from({ length: 50 }, () => repeated)];
  stub.historyDbs.clear();
  useBrowser.setState({ history: { "": { list: [], floor: -Infinity, ready: true } } });
  const view = new Map([[`h:${url}`, { t: "Repeat", n: vt.length, vt }]]);
  await adapters.historyAdapter("default").apply(view, new Set(view.keys()), () => undefined, { known: () => true, now, horizon: 0, joined: true });
  assert.deepEqual([...new Set(stub.chromeHistory("").get(url).visits)], [...older, repeated], "Chrome gets every distinct time");
  assert.deepEqual(useBrowser.getState().history[""].list.find((h) => h.url === url).visitTimes, [...older, repeated], "and so does the history list");
});

test("a synced record's visits a millisecond apart both reach Chrome and the history list", async () => {
  const now = Date.now();
  const url = "https://close.example/";
  const at = now - DAY;
  stub.historyDbs.clear();
  useBrowser.setState({ history: { "": { list: [], floor: -Infinity, ready: true } } });
  const view = new Map([[`h:${url}`, { t: "Close", n: 2, vt: [at, at + 1] }]]);
  await adapters.historyAdapter("default").apply(view, new Set(view.keys()), () => undefined, { known: () => true, now, horizon: 0, joined: true });
  assert.deepEqual(stub.chromeHistory("").get(url).visits, [at, at + 1]);
  assert.deepEqual(useBrowser.getState().history[""].list.find((h) => h.url === url).visitTimes, [at, at + 1]);
});
