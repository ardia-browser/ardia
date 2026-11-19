import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { resolveDrop } = await import("../drag/drops.ts");
const { splitTabIdsOf, splitOf } = await import("../splits/splits.ts");

const S = () => useBrowser.getState();
const host = (id) => new URL(S().tabs[id].pinnedUrl || S().tabs[id].url).hostname.replace(".com", "");
const view = (w, p) => model.viewTabIds(S(), w, p).map(host);
const shown = (w) => host(model.activeTabId(S(), w));
const pin = (id) => S().tabs[id].pin?.as ?? null;
const drop = (zone, beforeId = null, extra = {}) => resolveDrop(S(), { kind: "tab" }, { zone, beforeId, ...extra });

function spaces() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const id = { a: S().windows[w].tabIds[0] };
  for (const h of ["b", "c", "d"]) id[h] = S().newTab(w, { url: `https://${h}.com/`, background: true });
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(w, work);
  const first = model.activeTabId(S(), w);
  S().navigate(first, "https://x.com/");
  id.x = first;
  for (const h of ["y", "z"]) id[h] = S().newTab(w, { url: `https://${h}.com/`, background: true });
  S().switchProfile(w, "default");
  S().activate(id.a);
  return { w, id, work };
}

test("a tab dropped between two rows of another profile moves there in one update, lands at that slot and is shown", () => {
  const { w, id, work } = spaces();
  let updates = 0;
  const off = useBrowser.subscribe(() => updates++);
  assert.equal(S().dropTabsInProfile([id.b], work, drop("list", id.z)), true);
  off();
  assert.equal(updates, 1);
  assert.deepEqual(view(w, "default"), ["a", "c", "d"]);
  assert.deepEqual(view(w, work), ["x", "y", "b", "z"]);
  assert.equal(S().tabs[id.b].profileId, work);
  assert.equal(S().windows[w].profileId, work);
  assert.equal(shown(w), "b");
  assert.equal(S().tabs[id.b].page.nav?.url, "https://b.com/", "the page opens again in the other profile, as Move Tab to Profile does");
});

test("a selection moves together and keeps its order; with no slot it goes where Move Tab to Profile puts it", () => {
  const { w, id, work } = spaces();
  S().dropTabsInProfile([id.b, id.d], work, drop("list", id.x));
  assert.deepEqual(view(w, work), ["b", "d", "x", "y", "z"]);
  assert.equal(shown(w), "d");
  const again = spaces();
  S().dropTabsInProfile([again.id.c], again.work, { type: "none" });
  const dropped = [view(again.w, again.work), shown(again.w)];
  const expected = spaces();
  S().moveTabToProfile(expected.id.c, expected.work);
  assert.deepEqual(dropped, [view(expected.w, expected.work), shown(expected.w)]);
});

test("a group member leaves its group and a split pane leaves its split; the others stay home", () => {
  const { w, id, work } = spaces();
  const g = S().groupTabs([id.b, id.c], { name: "G", pinned: false });
  S().dropTabsInProfile([id.b], work, drop("list", null));
  assert.deepEqual(S().groups[g].tabIds.map(host), ["c"]);
  assert.ok(!Object.values(S().groups).some((group) => group.tabIds.includes(id.b)));
  assert.deepEqual(view(w, work), ["x", "y", "z", "b"]);
  const s2 = spaces();
  S().createSplit([s2.id.c, s2.id.d]);
  S().dropTabsInProfile([s2.id.c], s2.work, drop("list", s2.id.y));
  assert.equal(splitOf(S(), s2.id.c), undefined);
  assert.equal(splitTabIdsOf(splitOf(S(), s2.id.d))?.length ?? 0, 0);
  assert.deepEqual(view(s2.w, s2.work), ["x", "c", "y", "z"]);
});

test("the slot decides the pin: list unpins, pinned rows pin as a row, Top Apps as a tile, a profile icon keeps it", () => {
  const cases = [
    [drop("list", null), null],
    [drop("pinnedRows", null), "row"],
    [drop("tiles", null), "tile"],
    [{ type: "none" }, "row"],
  ];
  for (const [where, expected] of cases) {
    const { w, id, work } = spaces();
    S().pinTabs([id.c], true, true);
    assert.equal(pin(id.c), "row");
    assert.equal(S().dropTabsInProfile([id.c], work, where), true);
    assert.equal(pin(id.c), expected, JSON.stringify(where));
    assert.equal(S().tabs[id.c].profileId, work);
    assert.ok(!view(w, "default").includes("c"));
  }
});

test("into another profile's group at a member; a tab already there is only placed, and a private window's tab changes nothing", () => {
  const { w, id, work } = spaces();
  const g = S().groupTabs([id.y, id.z], { name: "W", pinned: false });
  S().dropTabsInProfile([id.a], work, drop("group", id.z, { groupId: g }));
  assert.deepEqual(S().groups[g].tabIds.map(host), ["y", "a", "z"]);
  const page = S().tabs[id.x].page;
  assert.equal(S().dropTabsInProfile([id.x], work, drop("list", null)), true);
  assert.equal(S().tabs[id.x].page, page, "placed, not opened again");
  assert.equal(view(w, work).at(-1), "x");
  const before = S();
  assert.equal(S().dropTabsInProfile([id.x], work, { type: "none" }), false, "no slot and nothing to move");
  assert.equal(S(), before);
  const p = S().createWindow({ kind: "private", url: "https://p.com/" });
  const priv = S().windows[p].tabIds[0];
  assert.equal(S().dropTabsInProfile([priv], work, drop("list", null)), false);
  assert.equal(S().dropTabsInProfile([id.b], "nobody", drop("list", null)), false);
});

test("a Top App shared with the other profile takes its copy there instead of making a second tile", () => {
  S().hydrate({});
  S().updateProfile("default", { shareTopApps: true });
  const w = S().createWindow({ url: "https://mail.com/" });
  const [mail] = S().windows[w].tabIds;
  S().newTab(w, { url: "https://a.com/" });
  S().pinTabs([mail], true);
  const work = S().createProfile({ name: "Work", shareTopApps: true, shareWith: "default" });
  S().switchProfile(w, work);
  const copy = model.viewTabIds(S(), w, work).find((t) => S().tabs[t].pinnedUrl === "https://mail.com/");
  assert.ok(copy && copy !== mail);
  S().switchProfile(w, "default");
  S().dropTabsInProfile([mail], work, drop("tiles", null));
  assert.equal(S().tabs[mail].profileId, "default");
  assert.equal(model.viewTabIds(S(), w, work).filter((t) => S().tabs[t].pinnedUrl === "https://mail.com/").length, 1);
  assert.equal(model.activeTabId(S(), w), copy);
});

test("a shared Top App dropped on the icon of a profile this window hasn't shown takes that profile's own copy, and each keeps one tile", async () => {
  const { NO_DROP } = await import("../drag/drops.ts");
  S().hydrate({});
  S().updateProfile("default", { shareTopApps: true });
  const w = S().createWindow({ url: "https://mail.com/" });
  const [mail] = S().windows[w].tabIds;
  S().newTab(w, { url: "https://a.com/" });
  S().pinTabs([mail], true);
  const work = S().createProfile({ name: "Work", shareTopApps: true, shareWith: "default" });
  assert.ok(S().parkedPins[work]?.tabs.some((p) => p.pinnedUrl === "https://mail.com/" || p.url === "https://mail.com/"), "the unvisited profile holds its copy parked");
  const mails = (p) => model.viewTabIds(S(), w, p).filter((t) => S().tabs[t].pinnedUrl === "https://mail.com/");
  const { movesAcrossProfiles } = await import("./profileMoves.ts");
  assert.equal(movesAcrossProfiles(S(), [mail], work), false, "showing a copy asks nothing");
  assert.equal(S().dropTabsInProfile([mail], work, NO_DROP), true);
  assert.equal(S().tabs[mail].profileId, "default", "the dragged tile stays in its profile");
  assert.deepEqual(mails("default"), [mail]);
  assert.equal(mails(work).length, 1, "the destination has one copy");
  assert.notEqual(mails(work)[0], mail);
  assert.equal(S().windows[w].profileId, work);
  assert.equal(model.activeTabId(S(), w), mails(work)[0], "and shows it");
});
