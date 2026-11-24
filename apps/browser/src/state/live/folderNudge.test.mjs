import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { onFrontTabChanged } = await import("../windows/frontTabs.ts");
const { openLiveItem, refreshFolder, startLiveEngine } = await import("./engine.ts");
const { SOURCES } = await import("./sources.ts");
const { createFolder, finishCompleting, live, removeFolder, updateFolder } = await import("./store.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };

const pr = (id, number) => ({
  id,
  source: "github",
  url: `https://github.com/o/r/pull/${number}`,
  title: `PR ${number}`,
  subtitle: "",
  icon: null,
  updatedAt: 0,
  section: "authored",
  pr: { number, repo: "o/r", headRef: `h${number}`, baseRef: "main" },
});

const listed = new Map();
const merged = new Set();
const fetches = new Map();
SOURCES.github.fetch = async (folder) => {
  fetches.set(folder.id, (fetches.get(folder.id) ?? 0) + 1);
  return listed.get(folder.id) ?? [];
};
SOURCES.github.resolveGone = async (items) => Object.fromEntries(items.flatMap((it) => (merged.has(it.id) ? [[it.id, "merged"]] : [])));

S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
const w = S().createWindow({ url: "https://start.example/" });
const start = S().windows[w].tabIds[0];
const stopWatchingFronts = onFrontTabChanged(() => {});
startLiveEngine();
after(() => {
  stopWatchingFronts();
  live().folderOrder.forEach(removeFolder);
});

async function leaveMergedTab(t, showCompleted) {
  const id = createFolder("default", "pullRequests", ["github"]);
  updateFolder(id, { showCompleted });
  const merging = pr(`${id}:0`, 1);
  listed.set(id, [merging]);
  await refreshFolder(id);
  const tab = openLiveItem(w, id, merging, { background: true });
  S().activate(tab);
  merged.add(merging.id);
  listed.set(id, []);
  await refreshFolder(id);
  finishCompleting(id, [merging.id]);
  assert.ok(S().tabs[tab], "the merged pull request's tab stays while it's in front");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const before = fetches.get(id) ?? 0;
  S().activate(start);
  t.mock.timers.tick(3000);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  return { tab, refreshed: (fetches.get(id) ?? 0) - before };
}

test("leaving a live tab that stays open refreshes its folder 3 s later", async (t) => {
  const { tab, refreshed } = await leaveMergedTab(t, true);
  assert.ok(S().tabs[tab]);
  assert.equal(refreshed, 1);
});

test("leaving a completed tab that closes at once refreshes nothing, even with another consumer of front tab changes started first", async (t) => {
  const { tab, refreshed } = await leaveMergedTab(t, false);
  assert.equal(S().tabs[tab], undefined, "the completed tab closed when it was left");
  assert.equal(refreshed, 0, "the nudge runs after the cleanup that closed the tab");
});
