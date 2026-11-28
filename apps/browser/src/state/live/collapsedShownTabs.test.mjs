import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { openLiveItem, refreshFolder, startLiveEngine } = await import("./engine.ts");
const { SOURCES } = await import("./sources.ts");
const { createFolder, hideItems, live, removeFolder, updateFolder } = await import("./store.ts");
const { liveFolderKeep, liveFolderShowsExtra, liveFolderTabRows } = await import("../sidebar/liveRows.ts");
const { hideShownTabs, settleLiveShownTabs, startLiveShownTabs } = await import("./shownTabs.ts");

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
SOURCES.github.fetch = async (folder) => listed.get(folder.id) ?? [];
SOURCES.github.resolveGone = async () => ({});

S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
const w = S().createWindow({ url: "https://start.example/" });
const plain = S().windows[w].tabIds[0];
startLiveEngine();
startLiveShownTabs();
after(() => live().folderOrder.forEach(removeFolder));

async function collapsedFolder(count = 3) {
  const id = createFolder("default", "pullRequests", ["github"]);
  const prs = Array.from({ length: count }, (_, i) => pr(`${id}:${i}`, i + 1));
  listed.set(id, prs);
  await refreshFolder(id);
  updateFolder(id, { collapsed: true });
  return { id, prs };
}

const listedTabs = (id) => liveFolderTabRows(S(), live(), w, "default", id).flat();

test("a pull request opened from a collapsed live folder stays under it after switching to another tab", async () => {
  const { id, prs } = await collapsedFolder();
  const opened = openLiveItem(w, id, prs[0]);
  assert.deepEqual(listedTabs(id), [opened]);
  S().activate(plain);
  assert.deepEqual(listedTabs(id), [opened], "the open pull request keeps its row while another tab is focused");
});

test("several pull requests opened while collapsed all stay, until their tabs close", async () => {
  const { id, prs } = await collapsedFolder();
  const first = openLiveItem(w, id, prs[0]);
  const second = openLiveItem(w, id, prs[2]);
  S().activate(plain);
  assert.deepEqual(new Set(listedTabs(id)), new Set([first, second]));
  S().closeTab(first);
  assert.deepEqual(listedTabs(id), [second], "a closed tab leaves the collapsed folder");
});

test("collapsing while a pull request is selected keeps it after switching away", async () => {
  const id = createFolder("default", "pullRequests", ["github"]);
  const prs = [pr(`${id}:0`, 1), pr(`${id}:1`, 2)];
  listed.set(id, prs);
  await refreshFolder(id);
  const opened = openLiveItem(w, id, prs[1]);
  updateFolder(id, { collapsed: true });
  S().activate(plain);
  assert.deepEqual(listedTabs(id), [opened]);
});

test("hiding the extras keeps the folder collapsed, and the focused row leaves once focus moves on", async () => {
  const { id, prs } = await collapsedFolder();
  const first = openLiveItem(w, id, prs[0]);
  const second = openLiveItem(w, id, prs[1]);
  hideShownTabs(id, w);
  assert.equal(live().folders[id].collapsed, true);
  assert.deepEqual(listedTabs(id), [second], "the focused pull request stays while it is focused");
  S().activate(plain);
  assert.deepEqual(listedTabs(id), [], "hidden rows don't come back when focus moves on, as in a collapsed group");
  assert.ok(S().tabs[first] && S().tabs[second], "hiding never closes a tab");
});

test("a pull request opened in the background from a collapsed folder stays under it", async () => {
  const { id, prs } = await collapsedFolder();
  const opened = openLiveItem(w, id, prs[2], { background: true });
  assert.notEqual(S().windows[w].activeTabIds.default, opened);
  assert.deepEqual(listedTabs(id), [opened]);
});

test("hiding the extras in one window leaves another window's kept rows alone", async () => {
  const { id, prs } = await collapsedFolder();
  const other = S().createWindow({ url: "https://other.example/" });
  const otherPlain = S().windows[other].tabIds[0];
  const here = openLiveItem(w, id, prs[0]);
  const there = openLiveItem(other, id, prs[1]);
  S().activate(plain);
  S().activate(otherPlain);
  hideShownTabs(id, w);
  assert.deepEqual(listedTabs(id), []);
  assert.deepEqual(liveFolderTabRows(S(), live(), other, "default", id).flat(), [there]);
  assert.ok(S().tabs[here]);
});

test("a kept pull request whose item gets hidden leaves the list", async () => {
  const { id, prs } = await collapsedFolder();
  const opened = openLiveItem(w, id, prs[0]);
  S().activate(plain);
  hideItems(id, [prs[0]]);
  assert.ok(!(live().shownTabs[id] ?? []).includes(opened));
});

test("expanding or collapsing starts over with the focused row only", async () => {
  const { id, prs } = await collapsedFolder();
  openLiveItem(w, id, prs[0]);
  const focused = openLiveItem(w, id, prs[1]);
  updateFolder(id, { collapsed: false });
  assert.equal(live().shownTabs[id], undefined, "an open folder keeps no list");
  updateFolder(id, { collapsed: true });
  assert.deepEqual(live().shownTabs[id], [focused]);
});

test("the settle step keeps its result when nothing changed, so subscribers aren't woken", () => {
  const shown = live().shownTabs;
  assert.equal(settleLiveShownTabs(shown, live().folders, S(), () => new Set()), shown);
});

test("two pull requests of one stack keep one row, and the header click only hides when a row would go", () => {
  const rows = [{ kind: "stack", key: "stack:s", id: "s", items: [{ id: "a" }, { id: "b" }] }, { kind: "item", key: "item:c", item: { id: "c" } }];
  const tabs = { t1: { liveItem: { itemId: "a" } }, t2: { liveItem: { itemId: "b" } }, t3: { liveItem: { itemId: "c" } } };
  assert.deepEqual(liveFolderKeep(rows, [], ["t1", "t2"], tabs), ["stack:s"]);
  assert.equal(liveFolderShowsExtra(rows, [], ["t1", "t2"], "t1", tabs), false, "hiding would leave the same stack row, so the click expands instead");
  assert.equal(liveFolderShowsExtra(rows, [], ["t1", "t3"], "t1", tabs), true);
  assert.equal(liveFolderShowsExtra(rows, [], ["t3"], "plain", tabs), true);
});
