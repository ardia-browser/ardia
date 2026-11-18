import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { droppingInProfile, movableToProfile } = await import("./profileMoves.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const host = (id) => new URL(S().tabs[id].url).hostname.split(".")[0];

function twoSpaces({ shareTopApps = false } = {}) {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const home = S().windows[w].profileId;
  if (shareTopApps) S().updateProfile(home, { shareTopApps: true });
  const work = S().createProfile({ name: "Work", ...(shareTopApps ? { shareWith: home, shareTopApps: true } : {}) });
  const id = { a: S().windows[w].tabIds[0] };
  for (const h of ["b", "c"]) id[h] = S().newTab(w, { url: `https://${h}.com/`, background: true });
  for (const h of ["x", "y"]) id[h] = S().newTab(w, { url: `https://${h}.com/`, background: true, profileId: work });
  S().activate(id.a);
  S().switchProfile(w, work);
  return { w, home, work, id };
}

const shownIn = (w, profileId) => S().windows[w].tabIds.filter((t) => S().tabs[t].profileId === profileId).map(host);

test("a tab dropped between another space's tabs joins that profile there, shown, and its old space shows a neighbour", () => {
  const { w, home, work, id } = twoSpaces();
  const dropped = S().dropTabsInProfile([id.a], work, { type: "tabs", placement: { pinned: false, beforeId: id.y } });
  assert.equal(dropped, true);
  assert.deepEqual(shownIn(w, work), ["x", "a", "y"]);
  assert.deepEqual(shownIn(w, home), ["b", "c"]);
  assert.equal(S().windows[w].profileId, work);
  assert.equal(S().windows[w].activeTabIds[work], id.a);
  assert.equal(host(S().windows[w].activeTabIds[home]), "b");
});

test("several tabs dropped together keep their order, and the first one given is the one shown", () => {
  const { w, work, id } = twoSpaces();
  S().dropTabsInProfile([id.c, id.a], work, { type: "tabs", placement: { pinned: false, beforeId: id.x } });
  assert.deepEqual(shownIn(w, work), ["a", "c", "x", "y"]);
  assert.equal(S().windows[w].activeTabIds[work], id.c);
});

test("a tab dropped on another space's Top Apps is pinned there, and one dropped onto a tab groups with it", () => {
  const { w, work, id } = twoSpaces();
  S().dropTabsInProfile([id.a], work, { type: "tabs", placement: { pinned: true, row: false, beforeId: null } });
  assert.equal(S().tabs[id.a].profileId, work);
  assert.equal(S().tabs[id.a].pin?.as ?? "tile", "tile");
  assert.ok(S().tabs[id.a].pin);
  S().dropTabsInProfile([id.b], work, { type: "onto", targetId: id.x });
  const group = Object.values(S().groups).find((g) => g.tabIds.includes(id.b));
  assert.deepEqual(group?.tabIds.map(host), ["x", "b"]);
  assert.equal(group?.profileId, work);
  assert.deepEqual(shownIn(w, work), ["a", "x", "b", "y"]);
});

test("nothing moves for a drop with no place, a tab already in that profile, or a profile that is gone", () => {
  const { work, id } = twoSpaces();
  const before = S();
  assert.equal(droppingInProfile(before, [id.a], work, { type: "none" }), before);
  assert.equal(droppingInProfile(before, [id.x], work, { type: "tabs", placement: { pinned: false, beforeId: null } }), before);
  assert.equal(droppingInProfile(before, [id.a], "p-gone", { type: "tabs", placement: { pinned: false, beforeId: null } }), before);
  assert.equal(S().dropTabsInProfile([id.a], work, { type: "none" }), false);
});

test("a Top App two profiles share stays put: both already show it", () => {
  const { home, work, id } = twoSpaces({ shareTopApps: true });
  S().pinTabs([id.a], true);
  assert.deepEqual(movableToProfile(S(), [id.a, id.b], work), [id.b]);
  S().dropTabsInProfile([id.a], work, { type: "tabs", placement: { pinned: false, beforeId: null } });
  assert.equal(S().tabs[id.a].profileId, home);
});

test("a private window's tabs never move to a profile", () => {
  const { work } = twoSpaces();
  const p = S().createWindow({ kind: "private", url: "https://secret.com/" });
  const secret = S().windows[p].tabIds[0];
  assert.deepEqual(movableToProfile(S(), [secret], work), []);
});
