import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { iconStripCodes, iconStripItems, stripItemCode, stripItemOf } = await import("./iconStrip.ts");

const S = () => useBrowser.getState();

function seeded() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://www.google.com/" });
  const [google] = S().windows[w].tabIds;
  const youtube = S().newTab(w, { url: "https://www.youtube.com/", background: true });
  S().pinTabs([google, youtube], true);
  const slack = S().newTab(w, { url: "https://app.slack.com/", background: true });
  const facebook = S().newTab(w, { url: "https://www.facebook.com/", background: true });
  const netflix = S().newTab(w, { url: "https://www.netflix.com/", background: true });
  const github = S().newTab(w, { url: "https://github.com/", background: true });
  const docs = S().newTab(w, { url: "https://docs.example/", background: true });
  return { w, google, youtube, slack, facebook, netflix, github, docs, profile: S().windows[w].profileId };
}

const kinds = (items) => items.map((i) => (i.kind === "tab" || i.kind === "tile" ? `${i.kind}:${i.tabId}` : i.kind === "group" ? `group:${i.groupId}` : i.kind));

test("Top Apps come first as one column, then a divider, then the tabs in sidebar order and the New Tab and space squares outside the list", () => {
  const t = seeded();
  const items = iconStripItems(S(), t.w, t.profile);
  assert.deepEqual(kinds(items), [`tile:${t.google}`, `tile:${t.youtube}`, "divider", `tab:${t.slack}`, `tab:${t.facebook}`, `tab:${t.netflix}`, `tab:${t.github}`, `tab:${t.docs}`]);
});

test("every group and folder shows its own icon, and while it's open its tabs follow it with a bar in its colour", () => {
  const t = seeded();
  const group = S().createGroup([t.facebook, t.netflix], { name: "Watch", color: "red" });
  const folder = S().createGroup([t.github, t.docs], { name: "Code" });
  S().updateGroup(folder, { color: null });
  let items = iconStripItems(S(), t.w, t.profile);
  const after = (groupId) => items.slice(items.findIndex((i) => i.kind === "group" && i.groupId === groupId));
  assert.deepEqual(after(group).slice(0, 3).map((i) => [i.kind, i.kind === "group" ? i.open : i.tabId, i.bar]), [
    ["group", true, null],
    ["tab", t.facebook, { color: "red", first: true, last: false }],
    ["tab", t.netflix, { color: "red", first: false, last: true }],
  ]);
  assert.deepEqual(after(folder).slice(0, 3).map((i) => [i.kind, i.kind === "group" ? i.open : i.tabId, i.bar]), [
    ["group", true, null],
    ["tab", t.github, { color: null, first: true, last: false }],
    ["tab", t.docs, { color: null, first: false, last: true }],
  ], "a folder without a colour follows the same rule");
  S().updateGroup(group, { collapsed: true });
  items = iconStripItems(S(), t.w, t.profile);
  assert.deepEqual(after(group)[0].open, false);
  assert.equal(items.some((i) => i.kind === "tab" && i.tabId === t.facebook), false, "a closed group keeps its tabs inside");
});

test("every item survives its string code, so the strip re-renders only when one changes", () => {
  const t = seeded();
  S().createGroup([t.facebook, t.netflix], { name: "Watch", color: "blue" });
  const items = iconStripItems(S(), t.w, t.profile);
  for (const item of items) assert.deepEqual(stripItemOf(stripItemCode(item)), item);
  const before = iconStripCodes(S(), t.w, t.profile);
  assert.deepEqual(iconStripCodes(S(), t.w, t.profile), before);
});

const { useLive } = await import("../live/store.ts");
const { pinnedSequence } = await import("./pinnedOrder.ts");
const { shownPinnedEntries, setPinnedCollapsed } = await import("./pinnedFold.ts");
const { sidebarEntries, groupEntries, keptEntries } = await import("./entries.ts");

function sidebarRenders(s, w, profileId) {
  const live = useLive.getState();
  const { cells, list } = sidebarEntries(s, w, profileId);
  const rows = [];
  const add = (entry) => {
    rows.push(entry);
    const group = entry.startsWith("g:") ? s.groups[entry.slice(2)] : null;
    if (group) (group.collapsed ? keptEntries(s, w, profileId, group.id) : groupEntries(s, group.id)).forEach(add);
  };
  shownPinnedEntries(s, w, profileId, pinnedSequence(s, live.folders, live.folderOrder, w, profileId)).forEach(add);
  list.forEach(add);
  return { tiles: cells.length, rows };
}

function stripShows(w, profileId) {
  const live = useLive.getState();
  const items = iconStripItems(S(), w, profileId, pinnedSequence(S(), live.folders, live.folderOrder, w, profileId));
  return { tiles: items.filter((i) => i.kind === "tile" || i.kind === "tileFolder").length, rows: items.filter((i) => !["tile", "tileFolder", "divider"].includes(i.kind)).map((i) => i.key) };
}

test("the strip shows exactly the rows the sidebar renders, live folders and the folded pinned section included", () => {
  const t = seeded();
  S().pinTabs([t.slack], true, true);
  const group = S().createGroup([t.github, t.docs], { name: "Code", color: "blue" });
  useLive.setState({ folders: { lf1: { id: "lf1", profileId: t.profile, after: null, collapsed: false } }, folderOrder: ["lf1"] });
  try {
    const check = (label) => assert.deepEqual(stripShows(t.w, t.profile), sidebarRenders(S(), t.w, t.profile), label);
    assert.ok(sidebarRenders(S(), t.w, t.profile).rows.includes("lf:lf1"), "the live folder is a sidebar row");
    check("pinned section open");
    S().updateGroup(group, { collapsed: true });
    check("group collapsed");
    setPinnedCollapsed(t.profile, true);
    check("pinned section folded");
    S().activate(t.slack);
    check("pinned section folded with its selected row kept");
  } finally {
    useLive.setState({ folders: {}, folderOrder: [] });
  }
});

test("a collapsed group's selected tab stays after its square with the group's bar, as the sidebar keeps it under the header, pinned or not", () => {
  for (const pinned of [false, true]) {
    const t = seeded();
    const group = S().createGroup([t.facebook, t.netflix, t.github], { name: "Watch", color: "red" });
    if (pinned) S().updateGroup(group, { pinned: true });
    S().updateGroup(group, { collapsed: true });
    S().activate(t.netflix);
    if (pinned) setPinnedCollapsed(t.profile, true);
    const label = pinned ? "kept in the folded pinned section" : "in the list";
    assert.deepEqual(stripShows(t.w, t.profile), sidebarRenders(S(), t.w, t.profile), label);
    const items = iconStripItems(S(), t.w, t.profile, pinnedSequence(S(), useLive.getState().folders, useLive.getState().folderOrder, t.w, t.profile));
    const at = items.findIndex((i) => i.kind === "group" && i.groupId === group);
    assert.deepEqual([items[at + 1]?.kind, items[at + 1]?.tabId, items[at + 1]?.bar], ["tab", t.netflix, { color: "red", first: true, last: true }], label);
  }
});
