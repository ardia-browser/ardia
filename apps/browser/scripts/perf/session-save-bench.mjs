#!/usr/bin/env node
const { useBrowser } = await import("../../src/state/browser/store.ts");
const stub = await import("../../src/test-native/index.ts");
const { SESSION_VERSION, flushPersistence, sessionSaved, startPersistence } = await import("../../src/state/session/persist.ts");
const { savedDocumentJson } = await import("../../src/state/session/documentJson.ts");

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? Number(process.argv[at + 1]) : fallback;
};
const TABS = arg("--tabs", 1500);
const RUNS = arg("--runs", 40);
const S = () => useBrowser.getState();

const HOSTS = ["github.com", "en.wikipedia.org", "news.ycombinator.com", "developer.apple.com", "docs.google.com", "linear.app"];
const t0 = 1_760_000_000_000;

function tab(id, windowId, profileId, i, extra = {}) {
  const host = HOSTS[i % HOSTS.length];
  return {
    id, windowId, profileId, url: `https://${host}/path/${i}?q=${"x".repeat(i % 40)}`, title: `Page ${i} on ${host} with a longer title ${"w".repeat(i % 30)}`,
    favicon: `https://${host}/favicon.ico`, pin: null, muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: null,
    page: i % 3 ? { kind: "asleep", wake: `restore:${i}` } : { kind: "idle" }, openerId: null, createdAt: t0 + i, lastActiveAt: t0 + i, ...extra,
  };
}

const snapshot = (i, profileId) => ({ id: `s${i}`, url: `https://${HOSTS[i % HOSTS.length]}/closed/${i}`, title: `Closed ${i} ${"t".repeat(i % 50)}`, favicon: null, profileId, createdAt: t0 + i });

function seed() {
  const profiles = {};
  const tabs = {};
  const groups = {};
  const windows = {};
  const parkedPins = {};
  const profileIds = ["default", "work", "play"];
  for (const [n, id] of profileIds.entries()) profiles[id] = { id, name: id, color: "plum", icon: null, createdAt: n };
  const perWindow = Math.ceil(TABS / 4);
  for (let w = 0; w < 4; w++) {
    const windowId = `w${w}`;
    const profileId = profileIds[w % profileIds.length];
    const ids = [];
    for (let i = 0; i < perWindow; i++) {
      const n = w * perWindow + i;
      const id = `t${n}`;
      tabs[id] = tab(id, windowId, profileId, n, i < 30 ? { pin: { as: i < 10 ? "tile" : "row" }, pinnedUrl: `https://${HOSTS[n % HOSTS.length]}/home` } : {});
      ids.push(id);
    }
    for (let g = 0; g < 8; g++) {
      groups[`g${w}-${g}`] = { id: `g${w}-${g}`, windowId, profileId, name: `Folder ${g}`, icon: null, color: null, collapsed: g % 2 === 0, pinned: g < 4, tabIds: ids.slice(30 + g * 12, 42 + g * 12), createdAt: t0 };
    }
    windows[windowId] = { id: windowId, profileId, kind: "main", tabIds: ids, activeTabIds: { [profileId]: ids[40] }, sidebarOpen: true, frame: { x: 0, y: 0, width: 1400, height: 900 }, createdAt: t0 };
  }
  for (const id of profileIds) {
    parkedPins[id] = { tabs: Array.from({ length: 60 }, (_, i) => ({ ...snapshot(i, id), id: `pp-${id}-${i}` })), groups: Array.from({ length: 6 }, (_, g) => ({ id: `pg-${id}-${g}`, name: `Parked ${g}`, tabIds: [`pp-${id}-${g}`], pinned: true })) };
  }
  const closedWindows = Array.from({ length: 10 }, (_, w) => ({
    id: `cw${w}`, closedAt: t0 + w, window: { id: `cww${w}`, profileId: "default", tabIds: [], activeTabIds: {} }, tabs: Array.from({ length: 80 }, (_, i) => snapshot(w * 100 + i, "default")), groups: [],
  }));
  const closedTabs = Array.from({ length: 50 }, (_, i) => ({ id: `ct${i}`, closedAt: t0 + i, tab: snapshot(i, "default"), windowId: "w0", index: i }));
  const cleanedTabs = Array.from({ length: 100 }, (_, i) => ({ id: `cl${i}`, closedAt: t0 + i, tab: snapshot(i, "work") }));
  const closedGroups = Array.from({ length: 20 }, (_, g) => ({ id: `cg${g}`, closedAt: t0 + g, group: { id: `cgg${g}`, name: `G${g}` }, tabs: Array.from({ length: 10 }, (_, i) => snapshot(g * 10 + i, "default")) }));
  stub.docs.set("session.json", JSON.stringify({ version: SESSION_VERSION, profiles, profileOrder: profileIds, settings: {}, windows: Object.values(windows), windowOrder: Object.keys(windows), focusedWindowId: "w0", tabs: Object.values(tabs), groups: Object.values(groups), splits: [], closedTabs, closedWindows, parkedPins, cleanedTabs, closedGroups, deletedGroups: [] }));
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const p90 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)];

async function timeSave(change, runs = RUNS) {
  const out = [];
  for (let i = 0; i < runs; i++) {
    change(i);
    const at = performance.now();
    flushPersistence();
    if (!(await sessionSaved())) throw new Error(`sample ${i} never reached session.json`);
    out.push(performance.now() - at);
  }
  return out;
}

const setTab = (id, patch) => useBrowser.setState((s) => ({ tabs: { ...s.tabs, [id]: { ...s.tabs[id], ...patch } } }));

stub.docs.clear();
seed();
const stop = startPersistence();
if (Object.keys(S().tabs).length < TABS * 0.9) throw new Error(`only ${Object.keys(S().tabs).length} tabs loaded`);
flushPersistence();
const loaded = Object.keys(S().tabs);
const pinnedIds = loaded.filter((id) => S().tabs[id].pin);
const tabAt = (n) => loaded[n % loaded.length];
setTab(tabAt(1), { title: "warm" });
flushPersistence();

const results = {
  title: await timeSave((i) => setTab(tabAt(100 + (i % 50)), { title: `Renamed ${i}` })),
  address: await timeSave((i) => setTab(tabAt(200 + (i % 50)), { url: `https://moved.example/${i}` })),
  setting: await timeSave((i) => useBrowser.setState((s) => ({ settings: { ...s.settings, benchCounter: i } }))),
  pinDrop: await timeSave((i) => {
    const id = pinnedIds[i % Math.min(25, pinnedIds.length)];
    setTab(id, { pin: S().tabs[id].pin ? null : { as: "row" } });
  }, Math.min(RUNS, 20)),
};
stop();

const bytes = savedDocumentJson("session.json", S()).length;
if (process.argv.includes("--json")) console.log(JSON.stringify({ tabs: TABS, bytes, ...Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { median: median(v), p90: p90(v) }])) }));
else {
  console.log(`session.json ${(bytes / 1024).toFixed(0)} KB, ${TABS} tabs, ${RUNS} runs`);
  for (const [name, xs] of Object.entries(results)) console.log(`${name.padEnd(10)} median ${median(xs).toFixed(2)} ms   p90 ${p90(xs).toFixed(2)} ms`);
}
