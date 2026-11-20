import assert from "node:assert/strict";
import { after, test } from "node:test";

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  const timer = realSetTimeout(callback, ms, ...args);
  return ms >= 1_000 ? timer.unref() : timer;
};
const unrefTimeout = globalThis.setTimeout;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
const { useBrowser } = await import("../browser/store.ts");
const { openLiveItem, refreshFolder, refreshFolderWhile, startLiveEngine } = await import("./engine.ts");
const { SOURCES } = await import("./sources.ts");
const { createFolder, hideItems, live, removeFolder, updateFolder } = await import("./store.ts");
const { takeWorkCounts } = await import("../telemetry/workCounts.ts");
const { takeLiveCompletedTabsClosed } = await import("../telemetry/liveCompletedTabs.ts");
after(() => client.setSharing(false, "settings"));
const sharing = (on) => {
  client.loadChoice();
  client.setSharing(on, "settings");
};

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const pr = (id, number) => ({ id, source: "github", url: `https://github.com/o/r/pull/${number}`, title: `PR ${number}`, subtitle: "", icon: null, updatedAt: 0, section: "authored", pr: { number, repo: "o/r", headRef: `h${number}`, baseRef: "main" } });

const listed = new Map();
const merged = new Set();
let holdFetch = null;
let fetchCalls = 0;
SOURCES.github.fetch = async (folder) => {
  fetchCalls++;
  if (holdFetch) await holdFetch;
  return listed.get(folder.id) ?? [];
};
SOURCES.github.resolveGone = async (items) => Object.fromEntries(items.flatMap((it) => (merged.has(it.id) ? [[it.id, "merged"]] : [])));

S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
const w = S().createWindow({ url: "https://start.example/" });
startLiveEngine();
after(() => live().folderOrder.forEach(removeFolder));

const fetches = () => takeWorkCounts().live_source_fetches;
const held = () => {
  let release = () => {};
  holdFetch = new Promise((resolve) => (release = resolve));
  return () => {
    holdFetch = null;
    release();
  };
};

async function folderWith(count) {
  sharing(true);
  const id = createFolder("default", "pullRequests", ["github"]);
  const prs = Array.from({ length: count }, (_, i) => pr(`${id}:${i}`, i + 1));
  listed.set(id, prs);
  await refreshFolder(id);
  return { id, prs };
}

test("a Live refresh queued behind a running one with sharing off isn't counted when it runs after sharing turns on", async () => {
  const { id } = await folderWith(1);
  sharing(false);
  const release = held();
  const running = refreshFolder(id);
  const queued = refreshFolderWhile(id, false, () => true);
  sharing(true);
  fetches();
  release();
  await running;
  await queued;
  assert.equal(fetches(), 0);
});

test("the refresh scheduled when you leave a Live tab with sharing off isn't counted when it runs after sharing turns on", async () => {
  const { id, prs } = await folderWith(1);
  const tab = openLiveItem(w, id, prs[0]);
  assert.equal(S().windows[w].activeTabIds[S().windows[w].profileId], tab);
  let nudge = null;
  globalThis.setTimeout = (callback, ms, ...args) => (ms === 3000 ? ((nudge = callback), 0) : unrefTimeout(callback, ms, ...args));
  sharing(false);
  S().newTab(w, { url: "https://elsewhere.example/" });
  globalThis.setTimeout = unrefTimeout;
  assert.ok(nudge, "leaving the Live tab schedules a refresh");
  sharing(true);
  fetches();
  const before = fetchCalls;
  nudge();
  await refreshFolder(id);
  assert.equal(fetchCalls - before, 1, "the scheduled refresh ran");
  assert.equal(fetches(), 0);
});

test("a Live refresh started with sharing off doesn't count closing a merged pull request's tab when it lands after sharing turns on", async () => {
  const { id, prs } = await folderWith(2);
  updateFolder(id, { showCompleted: false });
  const tab = openLiveItem(w, id, prs[0], { background: true });
  hideItems(id, [prs[0]]);
  merged.add(prs[0].id);
  listed.set(id, [prs[1]]);
  sharing(false);
  const release = held();
  const refreshing = refreshFolder(id);
  sharing(true);
  takeLiveCompletedTabsClosed();
  release();
  await refreshing;
  assert.equal(S().tabs[tab], undefined, "the merged pull request's tab still closes");
  assert.equal(takeLiveCompletedTabsClosed(), 0);
});
