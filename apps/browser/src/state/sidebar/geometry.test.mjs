import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { sidebarEntries } = await import("./entries.ts");
const { entriesHeight, entriesWithin, entryHeight, firstPaintEntries, rowSpan, startsOffScreen, FIRST_PAINT_HEIGHT } = await import("./geometry.ts");
const { groupEntries } = await import("./entries.ts");
const { GROUP_MEMBERS_PAD_BOTTOM: PAD } = await import("../../lib/sidebarMetrics.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const profile = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const tab = (i) => ({
  id: `t${i}`, windowId: "w", profileId: "default", url: `https://example.com/${i}`, title: `Tab ${i}`, favicon: null, pinned: false,
  muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: null, page: { kind: "idle" }, openerId: null, createdAt: i, lastActiveAt: i,
});

function hydrate({ collapsed = false, nested = null, active = "t0" } = {}) {
  const tabs = Array.from({ length: 40 }, (_, i) => tab(i));
  S().hydrate({
    profiles: { default: profile },
    windows: { w: { id: "w", profileId: "default", kind: "main", tabIds: tabs.map((t) => t.id), activeTabIds: { default: active }, sidebarOpen: true, frame: [0, 0, 1200, 800], createdAt: 0 } },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    groups: {
      g: { id: "g", windowId: "w", profileId: "default", name: "G", icon: null, color: "blue", collapsed, pinned: false, tabIds: ["t2", "t3", "t4", "t5", "t6"], createdAt: 0 },
      ...(nested ? { n: { id: "n", windowId: "w", profileId: "default", name: "N", icon: null, color: null, collapsed: true, pinned: false, tabIds: nested, parentId: "g", createdAt: 0 } } : {}),
    },
  });
  return sidebarEntries(S(), "w", "default").list;
}

test("entriesWithin counts the entries that start inside the height, a group as its whole block", () => {
  const list = hydrate();
  assert.deepEqual(list.slice(0, 4), ["t:t0", "t:t1", "g:g", "t:t7"]);
  const s = S();
  const pitch = entryHeight(s, "w", "default", "t:t0") + 3;
  assert.equal(entriesWithin(s, "w", "default", list, 0), 0);
  assert.equal(entriesWithin(s, "w", "default", list, 1), 1);
  assert.equal(entriesWithin(s, "w", "default", list, pitch), 1);
  assert.equal(entriesWithin(s, "w", "default", list, pitch + 1), 2);
  const group = entryHeight(s, "w", "default", "g:g");
  assert.ok(group > 5 * pitch);
  assert.equal(entriesWithin(s, "w", "default", list, 2 * pitch + 1), 3);
  assert.equal(entriesWithin(s, "w", "default", list, 2 * pitch + group + 3), 3);
  assert.equal(entriesWithin(s, "w", "default", list, 2 * pitch + group + 4), 4);
  assert.equal(entriesWithin(s, "w", "default", list, 1e6), list.length);
});

test("the entries within a height cover it: the rest start below it", () => {
  const list = hydrate({ collapsed: true });
  const s = S();
  for (const height of [10, 100, 333, 800, 1300]) {
    const n = entriesWithin(s, "w", "default", list, height);
    assert.ok(n === list.length || entriesHeight(s, "w", "default", list.slice(0, n)) + 3 >= height, `height ${height}`);
    assert.ok(n === 0 || entriesHeight(s, "w", "default", list.slice(0, n - 1)) + (n > 1 ? 3 : 0) < height, `height ${height}`);
  }
});

test("lazySidebarRows on: a page first mounts the entries its window's saved frame shows", () => {
  const list = hydrate();
  const s = S();
  const n = firstPaintEntries(s, "w", "default", list, true);
  assert.equal(n, entriesWithin(s, "w", "default", list, 800));
  assert.ok(n > 0 && n < list.length);
  S().hydrate({ ...s, windows: { w: { ...s.windows.w, frame: undefined } } });
  assert.equal(firstPaintEntries(S(), "w", "default", list, true), entriesWithin(S(), "w", "default", list, FIRST_PAINT_HEIGHT));
  assert.equal(startsOffScreen(true, false), true);
  assert.equal(startsOffScreen(true, true), false);
});

test("lazySidebarRows off: 64 entries at first, and no page waits", () => {
  const list = hydrate();
  assert.equal(firstPaintEntries(S(), "w", "default", list, false), 64);
  assert.equal(startsOffScreen(false, false), false);
  assert.equal(startsOffScreen(false, true), false);
});

test("a nested group first in its parent sits a row gap below the parent's header, and the members end an inset above the box's bottom edge, in the height and in the rows' positions", () => {
  for (const [nested, gap] of [[["t2", "t3"], 3], [["t5", "t6"], 0]]) {
    hydrate({ nested });
    const s = S();
    const members = groupEntries(s, "g");
    assert.equal(members[0], gap ? "g:n" : "t:t2");
    assert.equal(entryHeight(s, "w", "default", "g:g"), 1 + 34 + gap + entriesHeight(s, "w", "default", members) + PAD);
    assert.equal(rowSpan(s, "w", "default", "t4", false).top, 2 * 37 + 0.5 + 34 + gap + (gap ? entryHeight(s, "w", "default", "g:n") + 3 : 2 * 37));
  }
});

test("a collapsed group keeps its active nested group a row gap below its header", () => {
  hydrate({ collapsed: true, nested: ["t2", "t3"], active: "t3" });
  const s = S();
  assert.equal(entryHeight(s, "w", "default", "g:n"), 1 + 34 + 34 + PAD);
  assert.equal(entryHeight(s, "w", "default", "g:g"), 1 + 34 + 3 + entryHeight(s, "w", "default", "g:n") + PAD);
  assert.equal(rowSpan(s, "w", "default", "t3", false).top, 2 * 37 + 0.5 + 34 + 3 + 0.5 + 34);
});

test("the sidebar, group and strip entries stay the same lists through title and icon changes, and change on a pin, a first URL or a closed tab", async () => {
  const { stripEntries } = await import("../tabs/topStrip.ts");
  hydrate();
  const lists = () => [sidebarEntries(S(), "w"), sidebarEntries(S(), "w", "default"), stripEntries(S(), "w", "default"), groupEntries(S(), "g")];
  const before = lists();
  S().updateTab("t3", { title: "(3) Inbox", favicon: "https://example.com/unread.ico" });
  S().updateTab("t9", { title: "Another", muted: true, url: "https://example.com/elsewhere" });
  lists().forEach((list, i) => assert.equal(list, before[i], `list ${i} was rebuilt`));
  S().updateTab("t9", { pin: { as: "row" } });
  const pinned = lists();
  assert.ok(pinned[0].pinned.includes("t:t9"));
  assert.notEqual(pinned[2], before[2]);
  assert.equal(pinned[3], before[3], "the group holds what it held");
  S().updateTab("t3", { pin: { as: "tile" } });
  assert.ok(sidebarEntries(S(), "w").tiles.includes("t3"));
  S().closeTab("t5");
  assert.equal(groupEntries(S(), "g").includes("t:t5"), false);
  assert.equal(JSON.stringify(stripEntries(S(), "w", "default")).includes('"t5"'), false);
});

test("the entry lists read no tab field their cache doesn't compare", async () => {
  const { stripEntries } = await import("../tabs/topStrip.ts");
  const { ENTRY_TAB_FIELDS } = await import("./entries.ts");
  const { noRecordReads, trackedRecord } = await import("../browser/recordReads.ts");
  hydrate({ nested: ["t5", "t6"] });
  S().updateTab("t0", { pin: { as: "tile", folder: { id: "f", name: "F" } } });
  S().updateTab("t1", { pin: { as: "row" } });
  S().updateTab("t7", { url: "", title: "" });
  S().createSplit(["t8", "t9"]);
  assert.ok(sidebarEntries(S(), "w").list.some((e) => e.startsWith("s:")));
  const reads = noRecordReads();
  for (const newTabOpens of ["commandBar", "page"]) {
    S().updateSettings({ newTabOpens });
    const s = { ...S(), groups: { ...S().groups }, splits: { ...S().splits } };
    const tracked = { ...s, tabs: trackedRecord(s.tabs, reads) };
    sidebarEntries(tracked, "w", "default");
    stripEntries(tracked, "w", "default");
    for (const id of Object.keys(s.groups)) groupEntries(tracked, id);
  }
  const fields = new Set();
  for (const [id, read] of reads.entries) {
    assert.notEqual(read, null, `${id} was read whole`);
    for (const field of read) fields.add(field);
  }
  assert.ok(fields.has("pin") && fields.has("profileId"));
  assert.ok(fields.delete("id"), "an empty card is looked up in the splits by its id, which never changes");
  for (const field of fields) assert.ok(ENTRY_TAB_FIELDS.includes(field), `the entries read a tab's ${field}, which their cache doesn't compare`);
});

test("Minimalism mode hides an empty tab's row and strip entry as the command bar style does, and turning it off brings them back", async () => {
  const { stripEntries } = await import("../tabs/topStrip.ts");
  hydrate();
  S().updateSettings({ newTabOpens: "page", minimalismMode: false });
  S().updateTab("t7", { url: "", title: "" });
  const shows = () => [sidebarEntries(S(), "w").list.includes("t:t7"), sidebarEntries(S(), "w", "default").list.includes("t:t7"), JSON.stringify(stripEntries(S(), "w", "default")).includes('"t7"')];
  assert.deepEqual(shows(), [true, true, true]);
  S().updateSettings({ minimalismMode: true });
  assert.deepEqual(shows(), [false, false, false], "the lists kept what they held before Minimalism mode was turned on");
  S().updateSettings({ minimalismMode: false });
  assert.deepEqual(shows(), [true, true, true], "the lists kept what they held before Minimalism mode was turned off");
});
