import assert from "node:assert/strict";
import test from "node:test";
import { belongsToSpace, isSplit, moveTargets, sameSpaces, spaceOf, spaceToShow, tabSpacesFor, tabsInSpace, UNSYNCED, type TabSpaces } from "./spaces.ts";
import { closeAllTabs, closeTab, deckOrder, emptyTabs, moveToSpace, openTab, reopenLastClosed, runAutoArchive, selectTab, withSpaces, type TabsData } from "./tabsState.ts";

const known = ["personal", "work"];
const spaces = (current: string | null): TabSpaces => ({ current, defaultId: "personal", known });
const profiles = [
  { syncId: "personal", isDefault: true, name: "Personal" },
  { syncId: "work", isDefault: false, name: "Work" },
];

let ids = 0;

function open(data: TabsData, url: string, at: number, extra: { isPrivate?: boolean; after?: string; profileSyncId?: string | null } = {}) {
  const made = openTab(data, { url, origin: "typed", isPrivate: extra.isPrivate ?? false, after: extra.after, profileSyncId: extra.profileSyncId ?? data.spaces.current }, at, `S${++ids}`);
  return { data: made.change.data, tab: made.tab };
}

test("a tab with no space or a gone space belongs to the default", () => {
  const work = spaces("work");
  assert.equal(spaceOf(work, null), "personal");
  assert.equal(spaceOf(work, "deleted-on-the-mac"), "personal");
  assert.equal(spaceOf(work, "work"), "work");
  assert.ok(belongsToSpace(work, "work"));
  assert.ok(!belongsToSpace(work, null));
  assert.ok(belongsToSpace(spaces("personal"), null));
  assert.ok(belongsToSpace(spaces("personal"), "deleted-on-the-mac"));
});

test("without sync every tab is in the one space", () => {
  assert.ok(belongsToSpace(UNSYNCED, null));
  assert.ok(belongsToSpace(UNSYNCED, "work"));
  assert.ok(!isSplit(UNSYNCED));
  const waitingForProfiles: TabSpaces = { current: "work", defaultId: null, known: [] };
  assert.ok(belongsToSpace(waitingForProfiles, null));
  assert.ok(!isSplit(waitingForProfiles));
});

test("the redesign and Material You, with sync on and profiles, split tabs into spaces, defaulting to the marked profile or the first", () => {
  assert.deepEqual(tabSpacesFor("original", true, profiles, "work"), UNSYNCED);
  assert.deepEqual(tabSpacesFor("redesigned", false, profiles, "work"), UNSYNCED);
  assert.deepEqual(tabSpacesFor("redesigned", true, [], null), UNSYNCED);
  assert.deepEqual(tabSpacesFor("redesigned", true, profiles, "work"), { current: "work", defaultId: "personal", known });
  assert.deepEqual(tabSpacesFor("material", true, profiles, "work"), { current: "work", defaultId: "personal", known });
  const unmarked = profiles.map((p) => ({ ...p, isDefault: false })).reverse();
  assert.equal(tabSpacesFor("redesigned", true, unmarked, "work").defaultId, "work");
  assert.ok(sameSpaces(tabSpacesFor("redesigned", true, profiles, "work"), spaces("work")));
  assert.ok(!sameSpaces(spaces("work"), spaces("personal")));
});

test("the deck lists only the current space's tabs with every private tab, and every tab without sync", () => {
  let data = withSpaces(emptyTabs(), UNSYNCED);
  const before = open(data, "https://before-sync.example/", 1);
  data = withSpaces(before.data, spaces("personal"));
  const personal = open(data, "https://personal.example/", 2);
  data = withSpaces(personal.data, spaces("work"));
  const work = open(data, "https://work.example/", 3);
  assert.equal(work.tab.profileSyncId, "work");
  const secret = open(work.data, "https://secret.example/", 4, { isPrivate: true });
  data = secret.data;
  assert.deepEqual(deckOrder(data).map((t) => t.id), [work.tab.id, secret.tab.id]);
  data = withSpaces(data, spaces("personal"));
  assert.deepEqual(tabsInSpace(data.open, data.spaces).map((t) => t.id), [before.tab.id, personal.tab.id]);
  assert.deepEqual(new Set(deckOrder(data).map((t) => t.id)), new Set([before.tab.id, personal.tab.id, secret.tab.id]));
  data = withSpaces(data, UNSYNCED);
  assert.equal(deckOrder(data).length, 4);
});

test("switching spaces selects that space's last tab, or none, and a private tab stays selected", () => {
  let data = withSpaces(emptyTabs(), spaces("personal"));
  const older = open(data, "https://personal.example/older", 10);
  const newer = open(older.data, "https://personal.example/newer", 70);
  data = selectTab(newer.data, newer.tab.id, 130).data;
  data = withSpaces(data, spaces("work"));
  assert.equal(data.selectedId, null);
  const work = open(data, "https://work.example/", 190);
  assert.equal(work.data.selectedId, work.tab.id);
  data = withSpaces(work.data, spaces("personal"));
  assert.equal(data.selectedId, newer.tab.id);
  data = selectTab(data, older.tab.id, 250).data;
  const secret = open(data, "https://secret.example/", 260, { isPrivate: true });
  data = withSpaces(secret.data, spaces("work"));
  assert.equal(data.selectedId, secret.tab.id);
});

test("setting the same spaces again changes nothing", () => {
  const data = withSpaces(emptyTabs(), spaces("work"));
  assert.equal(withSpaces(data, { ...spaces("work"), known: [...known] }), data);
});

test("closing all closes only this space, but archiving watches every space", () => {
  let data = withSpaces(emptyTabs(), spaces("work"));
  const idle = open(data, "https://work.example/idle", 1);
  data = withSpaces(idle.data, spaces("personal"));
  const first = open(data, "https://personal.example/1", 2);
  const second = open(first.data, "https://personal.example/2", 3);
  const closed = closeAllTabs(second.data, 4);
  assert.deepEqual(closed.data.open.map((t) => t.id), [idle.tab.id]);
  assert.equal(closed.data.selectedId, null);
  assert.equal(deckOrder(closed.data).length, 0);
  const back = reopenLastClosed(closed.data, 5);
  assert.equal(deckOrder(back.change.data).length, 2);
  const aged = runAutoArchive(back.change.data, "day", 2 * 24 * 3_600_000 + 10);
  assert.ok(!aged.data.open.some((t) => t.id === idle.tab.id));
});

test("closing the selected tab selects its neighbour in the same space", () => {
  let data = withSpaces(emptyTabs(), spaces("personal"));
  const a = open(data, "https://personal.example/a", 1);
  data = withSpaces(a.data, spaces("work"));
  const x = open(data, "https://work.example/x", 2);
  data = withSpaces(x.data, spaces("personal"));
  const b = open(data, "https://personal.example/b", 3);
  const closed = closeTab(b.data, b.tab.id, 4);
  assert.equal(closed.data.selectedId, a.tab.id);
  const secret = open(closed.data, "https://secret.example/", 5, { isPrivate: true });
  const leftPrivate = closeTab(secret.data, secret.tab.id, 6);
  assert.equal(leftPrivate.data.selectedId, a.tab.id);
});

test("a tab can move to another space, which writes it and selects this space's last tab", () => {
  let data = withSpaces(emptyTabs(), spaces("personal"));
  const stays = open(data, "https://personal.example/stays", 1);
  const moves = open(stays.data, "https://personal.example/moves", 60);
  const change = moveToSpace(moves.data, moves.tab.id, "work");
  data = change.data;
  assert.deepEqual(deckOrder(data).map((t) => t.id), [stays.tab.id]);
  assert.equal(data.selectedId, stays.tab.id);
  assert.deepEqual(change.put.map((t) => [t.id, t.profileSyncId]), [[moves.tab.id, "work"]]);
  assert.equal(moveToSpace(data, moves.tab.id, "work").put.length, 0);
  data = withSpaces(data, spaces("work"));
  assert.deepEqual(deckOrder(data).map((t) => t.id), [moves.tab.id]);
});

test("a private tab can't move, and the targets are every other space", () => {
  assert.deepEqual(moveTargets(spaces("personal"), profiles, { isPrivate: false }).map((p) => p.syncId), ["work"]);
  assert.deepEqual(moveTargets(spaces("personal"), profiles, { isPrivate: true }), []);
  assert.deepEqual(moveTargets(UNSYNCED, profiles, { isPrivate: false }), []);
  const secret = open(emptyTabs(), "https://secret.example/", 1, { isPrivate: true });
  assert.equal(moveToSpace(secret.data, secret.tab.id, "work").put.length, 0);
});

test("opening a tab from another space shows that space; a private tab or one here shows nothing", () => {
  assert.equal(spaceToShow(spaces("work"), { profileSyncId: null, isPrivate: false }), "personal");
  assert.equal(spaceToShow(spaces("work"), { profileSyncId: "work", isPrivate: false }), null);
  assert.equal(spaceToShow(spaces("work"), { profileSyncId: null, isPrivate: true }), null);
  assert.equal(spaceToShow(UNSYNCED, { profileSyncId: "work", isPrivate: false }), null);
  assert.equal(spaceToShow(spaces("work"), null), null);
});

test("a tab opened from another tab takes the opener's space", () => {
  let data = withSpaces(emptyTabs(), spaces("work"));
  const opener = open(data, "https://work.example/", 1);
  data = withSpaces(opener.data, spaces("personal"));
  const child = open(data, "https://child.example/", 2, { after: opener.tab.id });
  assert.equal(child.tab.profileSyncId, "work");
});
