import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId, pinKeyOf } = await import("../browser/model.ts");
const { sidebarEntries, groupEntries } = await import("../sidebar/entries.ts");
const { useToasts } = await import("../app/toasts.ts");
const { splitTabIdsOf } = await import("./splits.ts");
const { splitsOnRow } = await import("./lanes.ts");
const { dropTabOnRow, dropTabIntoSplit, openInSplit } = await import("./actions.ts");

const S = () => useBrowser.getState();
const host = (id) => new URL(S().tabs[id].pinnedUrl || S().tabs[id].url).hostname.replace(".com", "");
const splitOfTab = (id) => Object.values(S().splits).find((v) => splitTabIdsOf(v).includes(id));
const panesOf = (w) => Object.values(S().splits).filter((v) => v.windowId === w).map((v) => splitTabIdsOf(v).map(host));
const order = (w) => S().windows[w].tabIds.map(host);
const lane = (id) => (!S().tabs[id].pin ? "list" : S().tabs[id].pin.as);

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  const id = { [hosts[0]]: S().windows[w].tabIds[0] };
  for (const h of hosts.slice(1)) id[h] = S().newTab(w, { url: `https://${h}.com/`, background: true });
  return { w, id };
}

function pinnedRows() {
  const W = windowWith("a", "b", "c", "d");
  S().pinTabs([W.id.a, W.id.b], true, true);
  return W;
}

test("a list tab dropped on a pinned row's right half becomes a pinned row in that split, right below the row, and is shown", () => {
  const { w, id } = pinnedRows();
  assert.equal(splitsOnRow(S(), id.c, id.a), true);
  const frames = [];
  const stop = useBrowser.subscribe((s) => frames.push(Object.values(s.splits).map((v) => splitTabIdsOf(v).map((t) => lane(t)))));
  assert.deepEqual(dropTabOnRow(id.c, id.a, "right"), { adopted: "row" });
  stop();
  assert.equal(frames.length, 1, "one store update");
  assert.deepEqual(frames[0], [["row", "row"]], "no frame shows a split across sections");
  const split = splitOfTab(id.c);
  assert.deepEqual(splitTabIdsOf(split), [id.a, id.c]);
  assert.equal(lane(id.c), "row");
  assert.equal(S().tabs[id.c].pinnedUrl, "https://c.com/", "pinned at its page, as Pin does");
  const key = pinKeyOf(S().tabs[id.c]);
  const mine = S().pinChoices[S().tabs[id.c].profileId] ?? {};
  assert.ok(mine[key] && mine[`place:${key}`], "the pin is recorded as a choice, as Pin records it, so sync carries it");
  assert.deepEqual(order(w), ["a", "c", "b", "d"]);
  assert.deepEqual(sidebarEntries(S(), w).pinned, [`s:${split.id}`, `t:${id.b}`]);
  assert.deepEqual(sidebarEntries(S(), w).list, [`t:${id.d}`]);
  assert.equal(activeTabId(S(), w), id.c);
});

test("a split that mixes a pinned row and a new unpinned pane gives the dropped tab the row's section on either half", () => {
  for (const side of ["left", "right"]) {
    const { id } = pinnedRows();
    const fresh = S().openSplitPane(S().tabs[id.a].windowId, { anchorTabId: id.a, side: "right" });
    assert.equal(fresh.ok, true);
    assert.equal(lane(fresh.tabId), "list", "a tab opened for the split stays unpinned");
    assert.deepEqual(dropTabOnRow(id.c, id.a, side), { adopted: "row" }, side);
    assert.equal(lane(id.c), "row", side);
    assert.ok(splitTabIdsOf(splitOfTab(id.c)).includes(id.a), side);
  }
});

test("on the left half the dropped tab takes the left pane and still sits right below the row", () => {
  const { w, id } = pinnedRows();
  assert.deepEqual(dropTabOnRow(id.d, id.b, "left"), { adopted: "row" });
  assert.deepEqual(splitTabIdsOf(splitOfTab(id.d)), [id.d, id.b]);
  assert.equal(lane(id.d), "row");
  assert.deepEqual(order(w), ["a", "b", "d", "c"]);
});

test("a pinned row dropped on a list tab's half becomes a list tab in that split, right below the tab", () => {
  const { w, id } = pinnedRows();
  assert.equal(splitsOnRow(S(), id.a, id.d), true);
  assert.deepEqual(dropTabOnRow(id.a, id.c, "right"), { adopted: "list" });
  const split = splitOfTab(id.a);
  assert.deepEqual(splitTabIdsOf(split), [id.c, id.a]);
  assert.equal(S().tabs[id.a].pin, null);
  assert.equal(S().tabs[id.a].pinnedUrl, null, "unpinned as Unpin does");
  assert.deepEqual(order(w), ["b", "c", "a", "d"]);
  assert.deepEqual(sidebarEntries(S(), w).pinned, [`t:${id.b}`]);
  assert.deepEqual(sidebarEntries(S(), w).list, [`s:${split.id}`, `t:${id.d}`]);
  assert.equal(activeTabId(S(), w), id.a);
});

const UNSPLITS = {
  "Remove from Split View on the dropped pane": (ids) => S().removeTabFromSplit(ids.dropped),
  "Remove from Split View on the anchor": (ids) => S().removeTabFromSplit(ids.anchor),
  "Separate All Tabs": (ids) => S().separateSplit(splitOfTab(ids.dropped).id),
};

test("undoing an adopted pinned split leaves the dropped tab a pinned row right below the anchor, every way", () => {
  for (const [how, undo] of Object.entries(UNSPLITS)) {
    const { w, id } = pinnedRows();
    dropTabOnRow(id.c, id.a, "left");
    undo({ dropped: id.c, anchor: id.a });
    assert.equal(splitOfTab(id.c), undefined, how);
    assert.equal(lane(id.c), "row", how);
    assert.deepEqual(order(w), ["a", "c", "b", "d"], how);
    assert.deepEqual(sidebarEntries(S(), w).pinned, [`t:${id.a}`, `t:${id.c}`, `t:${id.b}`], how);
  }
});

test("closing a pane of an adopted pinned split keeps it a pinned split, as any pinned split", () => {
  const { w, id } = pinnedRows();
  dropTabOnRow(id.c, id.a, "right");
  S().closeTab(id.c);
  assert.deepEqual(splitTabIdsOf(splitOfTab(id.c)), [id.a, id.c]);
  assert.equal(lane(id.c), "row");
  assert.deepEqual(sidebarEntries(S(), w).pinned.length, 2);
});

test("undoing an adopted list split leaves the dropped tab a list tab right below the anchor, every way, closing the anchor too", () => {
  const ways = { ...UNSPLITS, "closing the anchor": (ids) => S().closeTab(ids.anchor) };
  for (const [how, undo] of Object.entries(ways)) {
    const { w, id } = pinnedRows();
    dropTabOnRow(id.b, id.c, "left");
    undo({ dropped: id.b, anchor: id.c });
    assert.equal(splitOfTab(id.b), undefined, how);
    assert.equal(lane(id.b), "list", how);
    const expected = how === "closing the anchor" ? ["a", "b", "d"] : ["a", "c", "b", "d"];
    assert.deepEqual(order(w), expected, how);
  }
});

test("a Top Apps tile never splits a row by drop, and a row never splits a tile", () => {
  const { w, id } = pinnedRows();
  S().pinTabs([id.d], true, false);
  assert.equal(lane(id.d), "tile");
  for (const [tab, row] of [[id.d, id.a], [id.d, id.c], [id.a, id.d], [id.c, id.d]]) {
    assert.equal(splitsOnRow(S(), tab, row), false);
    assert.equal(dropTabOnRow(tab, row, "right"), null);
  }
  assert.deepEqual(Object.keys(S().splits), []);
  assert.equal(lane(id.d), "tile");
  assert.equal(S().windows[w].tabIds.length, 4);
});

test("a third pane dropped on a pinned split row from the list joins it as a pinned row next to its anchor, and a full split refuses", () => {
  const { w, id } = pinnedRows();
  const split = S().createSplit([id.a, id.b]);
  assert.deepEqual(dropTabOnRow(id.c, id.a, "left"), { adopted: "row" });
  assert.deepEqual(splitTabIdsOf(S().splits[split]), [id.c, id.a, id.b]);
  assert.equal(lane(id.c), "row");
  assert.deepEqual(order(w), ["a", "c", "b", "d"]);
  assert.deepEqual(sidebarEntries(S(), w).pinned, [`s:${split}`]);

  assert.equal(dropTabOnRow(id.d, id.a, "right"), null);
  assert.deepEqual(splitTabIdsOf(S().splits[split]), [id.c, id.a, id.b]);
  assert.equal(lane(id.d), "list", "a refused drop leaves the tab where it was");
  assert.equal(useToasts.getState().toasts[w]?.title, "Cannot Add New Pane");
});

test("a pinned row dropped on a list split row becomes its third pane as a list tab", () => {
  const { w, id } = pinnedRows();
  const split = S().createSplit([id.c, id.d]);
  assert.deepEqual(dropTabOnRow(id.a, id.c, "right"), { adopted: "list" });
  assert.deepEqual(splitTabIdsOf(S().splits[split]), [id.c, id.d, id.a]);
  assert.equal(lane(id.a), "list");
  assert.deepEqual(sidebarEntries(S(), w).list, [`s:${split}`]);
});

test("the page's split targets and Open as Split take the anchor's section just as a sidebar drop does", () => {
  const ways = {
    "page edge": (tab, anchor) => dropTabIntoSplit(tab, anchor, "right"),
    "Open as Split": (tab, anchor) => (S().activate(anchor), openInSplit(tab, "right")),
  };
  for (const [how, open] of Object.entries(ways)) {
    const { w, id } = pinnedRows();
    open(id.c, id.a);
    assert.deepEqual(splitTabIdsOf(splitOfTab(id.c)), [id.a, id.c], how);
    assert.equal(lane(id.c), "row", how);
    assert.deepEqual(order(w), ["a", "c", "b", "d"], how);

    open(id.b, id.d);
    assert.deepEqual(splitTabIdsOf(splitOfTab(id.b)), [id.d, id.b], how);
    assert.equal(lane(id.b), "list", how);
  }
});

test("a tab opened for the split beside a pinned row keeps today's rule and stays in the list", () => {
  const { w, id } = pinnedRows();
  const r = S().openSplitPane(w, { tabId: id.c, anchorTabId: id.a, side: "right", openedForSplit: true });
  assert.equal(r.ok, true);
  assert.equal(lane(id.c), "list");
});

test("an adopted pinned split shows in the profile's other windows like any pinned split, and the mirror case leaves them", () => {
  const { w, id } = pinnedRows();
  const other = S().createWindow({ url: "https://z.com/" });
  dropTabOnRow(id.c, id.a, "right");
  assert.deepEqual(panesOf(other), [["a", "c"]]);
  dropTabOnRow(id.b, id.d, "right");
  const pinnedThere = sidebarEntries(S(), other).pinned;
  assert.equal(pinnedThere.length, 1, "b left the pinned rows everywhere");
  assert.deepEqual(panesOf(w).sort(), [["a", "c"], ["d", "b"]].sort());
});

test("a pinned row dropped on a grouped list tab joins its group as part of the split", () => {
  const { w, id } = pinnedRows();
  const g = S().groupTabs([id.c, id.d], { pinned: false, name: "G" });
  assert.deepEqual(dropTabOnRow(id.a, id.c, "right"), { adopted: "list" });
  const split = splitOfTab(id.a);
  assert.deepEqual(new Set(S().groups[g].tabIds), new Set([id.c, id.a, id.d]));
  assert.deepEqual(groupEntries(S(), g), [`s:${split.id}`, `t:${id.d}`]);
  assert.deepEqual(sidebarEntries(S(), w).list, [`g:${g}`]);
});

test("a drop that makes no split says so: a refused pair, a pane already in the split, a full split", () => {
  const { w, id } = pinnedRows();
  S().pinTabs([id.d], true, false);
  assert.equal(dropTabOnRow(id.d, id.c, "right"), null, "a tile");
  assert.deepEqual(dropTabOnRow(id.c, id.b, "right"), { adopted: "row" });
  assert.equal(dropTabOnRow(id.c, id.b, "left"), null, "already a pane there");
  const split = splitOfTab(id.c).id;
  const third = S().newTab(w, { url: "https://e.com/", background: true });
  S().pinTabs([third], true, true);
  assert.deepEqual(dropTabOnRow(third, id.b, "right"), { adopted: null }, "a pinned row joins a pinned split with no section change");
  const fourth = S().newTab(w, { url: "https://f.com/", background: true });
  assert.equal(dropTabOnRow(fourth, id.b, "right"), null, "a full split");
  assert.equal(splitTabIdsOf(S().splits[split]).length, 3);
  assert.equal(useToasts.getState().toasts[w]?.title, "Cannot Add New Pane");
});
