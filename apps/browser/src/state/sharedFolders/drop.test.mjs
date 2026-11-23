import assert from "node:assert/strict";
import { test } from "node:test";
const { shellNativeModules } = await import("../../test-native/shell.ts");
globalThis.acTestNativeModules = { ArdiaSharedFolders: { location: () => ({ path: "/scratch", iCloudAvailable: true, iCloudPath: "/scratch" }) } };
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { pinKeyOf } = await import("../browser/model.ts");
const { resolveDrop } = await import("../drag/drops.ts");
const { guardGroupClose, keepGroupsOpen } = await import("../groups/closeGuard.ts");
const { dropTabOnRow } = await import("../splits/actions.ts");
const { dropTabsOutside } = await import("../drag/windowDrop.ts");
const { bindFolder } = await import("./store.ts");
const { confirmRemovingShared, sharedFolderOfGroup } = await import("./removal.ts");
const { folderPlace } = await import("./engine.ts");
const { dropTabIntoSplit } = await import("../splits/actions.ts");
const { dropTabsInProfile } = await import("../browser/actions.ts");
const { knownNames, localFolder } = await import("./local.ts");
const { foreignWriteHooks } = await import("../browser/foreignWriteHooks.ts");
const { devTabPresses } = await import("../telemetry/tabPresses.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

const S = () => useBrowser.getState();
guardGroupClose(confirmRemovingShared);
keepGroupsOpen((groupId, s = S()) => !!sharedFolderOfGroup(s, groupId));
const settle = () => new Promise(setImmediate);

function answering(t, confirmed, meanwhile = () => {}) {
  const real = shellNativeModules.ArdiaDialogs.confirm;
  const asked = [];
  shellNativeModules.ArdiaDialogs.confirm = async (options) => (asked.push(options.title), meanwhile(), { confirmed, suppressed: false });
  t.after(() => (shellNativeModules.ArdiaDialogs.confirm = real));
  return asked;
}

let runs = 0;
function sidebar({ shared = true, links = 1 } = {}) {
  S().hydrate({});
  runs++;
  const w = S().createWindow({ url: `https://home${runs}.example/` });
  const home = S().windows[w].tabIds[0];
  const other = S().newTab(w, { url: `https://other${runs}.example/`, background: true });
  const ids = Array.from({ length: links }, (_, i) => S().newTab(w, { url: `https://link${runs}-${i}.example/`, background: true }));
  const team = S().groupTabs(ids, { pinned: true, name: "Team" });
  const profileId = S().groups[team].profileId;
  const key = pinKeyOf(S().groups[team]);
  if (shared) bindFolder(profileId, key, `/scratch/Team ${runs}`);
  return { w, home, other, ids, team, profileId, key };
}

const rows = (groupId) => S().groups[groupId]?.tabIds.map((id) => S().tabs[id].customTitle ?? S().tabs[id].url);
const staysShared = ({ profileId, key }) => assert.equal(folderPlace(S(), profileId, key).kind, "shown", "the sync engine still finds the folder");
const dropGroup = (groupId, spot) => S().dropTabs([], resolveDrop(S(), { kind: "group", groupId }, spot));
const dropTab = (id, spot) => S().dropTabs([id], resolveDrop(S(), { kind: "tab" }, spot));

test("dragging a shared folder out of Pinned asks as Unpin does, and No leaves it pinned and shared", async (t) => {
  const asked = answering(t, false);
  const f = sidebar();
  dropGroup(f.team, { zone: "list", beforeId: null });
  assert.equal(S().groups[f.team].pinned, true, "nothing moves before the answer");
  await settle();
  assert.deepEqual(asked, ["Remove “Team” from the Sidebar?"]);
  assert.equal(S().groups[f.team].pinned, true);
  staysShared(f);
});

test("dragging a shared folder out of Pinned moves it once confirmed", async (t) => {
  const asked = answering(t, true);
  const f = sidebar();
  dropGroup(f.team, { zone: "list", beforeId: null });
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(S().groups[f.team].pinned, false);
});

test("nesting a shared folder in another pinned folder asks too", async (t) => {
  const asked = answering(t, false);
  const f = sidebar();
  const outer = S().groupTabs([f.other], { pinned: true, name: "Outer" });
  dropGroup(f.team, { zone: "group", groupId: outer, beforeId: null });
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(S().groups[f.team].parentId, undefined);
  staysShared(f);
});

test("reordering a shared folder inside Pinned and dragging an unshared one out ask nothing", async (t) => {
  const asked = answering(t, false);
  const f = sidebar();
  const outer = S().groupTabs([f.other], { pinned: true, name: "Outer" });
  dropGroup(f.team, { zone: "pinnedRows", beforeId: S().groups[outer].tabIds[0] });
  dropGroup(outer, { zone: "list", beforeId: null });
  await settle();
  assert.deepEqual(asked, []);
  assert.equal(S().groups[outer].pinned, false);
  staysShared(f);
});

for (const [where, spot] of [
  ["the tab list", () => ({ zone: "list", beforeId: null })],
  ["Pinned, outside the folder", () => ({ zone: "pinnedRows", beforeId: null })],
  ["Top Apps", () => ({ zone: "tiles", beforeId: null })],
  ["another group", (f) => ({ zone: "group", groupId: S().groupTabs([f.other], { pinned: false, name: "Reading" }), beforeId: null })],
]) {
  test(`dragging a shared folder's only link into ${where} leaves an Empty Folder row and keeps it shared`, () => {
    const f = sidebar();
    assert.equal(dropTab(f.ids[0], spot(f)), true);
    assert.deepEqual(rows(f.team), ["Empty Folder"]);
    assert.equal(S().groups[f.team].pinned, true);
    assert.equal(S().groups[f.team].tabIds.includes(f.ids[0]), false);
    staysShared(f);
  });
}

test("dropping a shared folder's only link beside a list row as a split keeps the folder", () => {
  const f = sidebar();
  dropTabOnRow(f.ids[0], f.home, "right");
  assert.equal(S().groups[f.team]?.tabIds.includes(f.ids[0]), false, "the link joined the row");
  assert.deepEqual(rows(f.team), ["Empty Folder"]);
  staysShared(f);
});

test("dropping a shared folder's only link in another profile keeps the folder in its own", () => {
  const f = sidebar();
  const work = S().createProfile({ name: "Work" });
  assert.ok(S().dropTabsInProfile([f.ids[0]], work, { type: "none" }));
  assert.equal(S().tabs[f.ids[0]].profileId, work);
  assert.deepEqual(rows(f.team), ["Empty Folder"]);
  staysShared(f);
});

test("dropping a shared folder's only link on another window keeps the folder", () => {
  const f = sidebar();
  const second = S().createWindow({ url: "https://second.example/" });
  S().moveTabsToWindow([f.ids[0]], second);
  staysShared(f);
});

test("with the folder shown in two windows, both keep it with one Empty Folder row", () => {
  const f = sidebar();
  const second = S().createWindow({ profileId: f.profileId });
  const copies = () => Object.values(S().groups).filter((g) => g.profileId === f.profileId && pinKeyOf(g) === f.key);
  assert.equal(copies().length, 2, "setup: the second window mirrors it");
  dropTab(f.ids[0], { zone: "list", beforeId: null });
  assert.deepEqual(copies().map((g) => [g.windowId === second || g.windowId === f.w, rows(g.id)]), [[true, ["Empty Folder"]], [true, ["Empty Folder"]]]);
  staysShared(f);
});

test("the Empty Folder row keeps the folder's place among pinned folders", () => {
  const f = sidebar();
  const below = S().groupTabs([f.other], { pinned: true, name: "Below" });
  dropGroup(f.team, { zone: "pinnedRows", beforeId: S().groups[below].tabIds[0] });
  dropTab(f.ids[0], { zone: "list", beforeId: null });
  const order = S().windows[f.w].tabIds;
  assert.ok(order.indexOf(S().groups[f.team].tabIds[0]) < order.indexOf(f.other));
});

test("a link that leaves others behind adds no row, and an unshared folder still goes with its last link", () => {
  const two = sidebar({ links: 2 });
  dropTab(two.ids[0], { zone: "list", beforeId: null });
  assert.deepEqual(S().groups[two.team].tabIds, [two.ids[1]]);
  const plain = sidebar({ shared: false });
  dropTab(plain.ids[0], { zone: "list", beforeId: null });
  assert.equal(S().groups[plain.team], undefined);
});

test("dragging one of two links out of a shared folder made by ⌘-click keeps the other link, and its file", () => {
  const f = sidebar({ links: 2 });
  useBrowser.setState((s) => ({ groups: { ...s.groups, [f.team]: { ...s.groups[f.team], autoUngroup: true } } }));
  dropTab(f.ids[0], { zone: "list", beforeId: null });
  assert.deepEqual(S().groups[f.team]?.tabIds, [f.ids[1]]);
  staysShared(f);
});

test("emptying two shared folders at once keeps their order", () => {
  const a = sidebar();
  const link = S().newTab(a.w, { url: `https://second-link${runs}.example/`, background: true });
  const b = S().groupTabs([link], { pinned: true, name: "Second" });
  bindFolder(a.profileId, pinKeyOf(S().groups[b]), `/scratch/Second ${runs}`);
  const rank = (groupId) => S().windows[a.w].tabIds.indexOf(S().groups[groupId].tabIds[0]);
  const first = rank(a.team) < rank(b);
  S().dropTabs([a.ids[0], link], resolveDrop(S(), { kind: "tab" }, { zone: "list", beforeId: null }));
  assert.equal(rank(a.team) < rank(b), first);
  staysShared(a);
});

test("the Empty Folder row never lands inside the folder above", () => {
  const f = sidebar();
  const above = S().groupTabs([f.other], { pinned: true, name: "Above" });
  S().moveGroup(above, { pinned: true, beforeId: f.ids[0] });
  dropTab(f.ids[0], { zone: "group", groupId: above, beforeId: null });
  const order = S().windows[f.w].tabIds;
  const at = S().groups[above].tabIds.map((id) => order.indexOf(id));
  assert.equal(Math.max(...at) - Math.min(...at) + 1, at.length, "the folder above stays in one piece");
  staysShared(f);
});

for (const [where, drop] of [
  ["the tab list", (f, row) => dropTab(row, { zone: "list", beforeId: null })],
  ["a split", (f, row) => dropTabOnRow(row, f.home, "right")],
  ["another profile", (f, row) => S().dropTabsInProfile([row], S().createProfile({ name: "Elsewhere" }), { type: "none" })],
]) {
  test(`the Empty Folder row itself can't be dragged into ${where}`, () => {
    const f = sidebar();
    dropTab(f.ids[0], { zone: "list", beforeId: null });
    const row = S().groups[f.team].tabIds[0];
    drop(f, row);
    assert.deepEqual(S().groups[f.team].tabIds, [row]);
    assert.equal(S().tabs[row].profileId, f.profileId);
  });
}

test("dropping a window's last tab, a shared folder's only link, on another profile's window takes the folder along", () => {
  const f = sidebar();
  S().closeTabs([f.home, f.other]);
  const target = S().createWindow({ profileId: S().createProfile({ name: "Away" }), url: "https://away.example/" });
  S().moveTabsToWindow([f.ids[0]], target);
  staysShared(f);
  const kept = S().groups[f.team];
  assert.equal(kept.windowId, target);
  assert.deepEqual(kept.tabIds, [f.ids[0]], "the link stays in it, so its file stays too");
});

test("a folder unpinned while the question is up isn't pinned again by the answer", async (t) => {
  const f = sidebar();
  const outer = S().groupTabs([f.other], { pinned: true, name: "Outer" });
  const real = shellNativeModules.ArdiaDialogs.confirm;
  shellNativeModules.ArdiaDialogs.confirm = async () => (S().moveGroup(f.team, { pinned: false }), { confirmed: true, suppressed: false });
  t.after(() => (shellNativeModules.ArdiaDialogs.confirm = real));
  dropGroup(f.team, { zone: "group", groupId: outer, beforeId: null });
  await settle();
  assert.equal(S().groups[f.team].parentId, undefined);
  assert.equal(S().groups[f.team].pinned, false);
});

test("an answer that can't move the folder any more isn't counted as a confirmed removal", async (t) => {
  setConsentPeriod(true, "drop-test");
  t.after(() => setConsentPeriod(false, null));
  const f = sidebar();
  const outer = S().groupTabs([f.other], { pinned: true, name: "Outer" });
  const real = shellNativeModules.ArdiaDialogs.confirm;
  shellNativeModules.ArdiaDialogs.confirm = async () => (S().ungroup(outer), { confirmed: true, suppressed: false });
  t.after(() => (shellNativeModules.ArdiaDialogs.confirm = real));
  const counted = devTabPresses().drops_shared_folder_confirmed;
  const asked = devTabPresses().drops_shared_folder_asked;
  dropGroup(f.team, { zone: "group", groupId: outer, beforeId: null });
  await settle();
  staysShared(f);
  assert.equal(devTabPresses().drops_shared_folder_confirmed, counted);
  assert.equal(devTabPresses().drops_shared_folder_asked, asked + 1);
});

const intoList = () => ({ zone: "list" });
const intoOuter = (f) => {
  const groupId = S().groupTabs([f.other, f.home], { pinned: true, name: "Outer" });
  return { zone: "group", groupId };
};

for (const [what, into, change] of [
  ["closed", intoList, (f) => S().closeTab(f.other)],
  ["pinned as a row", intoList, (f) => S().pinTabs([f.other], true, true)],
  ["pinned as a tile", intoList, (f) => S().pinTabs([f.other], true, false)],
  ["grouped in Pinned", intoList, (f) => S().groupTabs([f.other], { pinned: true, name: "Kept" })],
  ["moved to another window", intoList, (f) => S().moveTabsToWindow([f.other], null)],
  ["moved to another profile", intoList, (f) => S().moveTabToProfile(f.other, S().createProfile({ name: "Work" }))],
  ["taken out of the folder it was in", intoOuter, (f) => S().placeTabs([f.other], { pinned: false, groupId: null })],
]) {
  test(`a confirmed drop before a row that was ${what} meanwhile leaves the folder as it was`, async (t) => {
    setConsentPeriod(true, `drop-test-${what}`);
    t.after(() => setConsentPeriod(false, null));
    const f = sidebar();
    const spot = into(f);
    answering(t, true, () => change(f));
    const counted = devTabPresses().drops_shared_folder_confirmed;
    dropGroup(f.team, { ...spot, beforeId: f.other });
    await settle();
    assert.equal(S().groups[f.team].pinned, true);
    assert.equal(S().groups[f.team].parentId, undefined);
    staysShared(f);
    assert.equal(devTabPresses().drops_shared_folder_confirmed, counted);
  });
}

for (const [what, into, change] of [
  ["unchanged", intoList, () => {}],
  ["grouped in the list", intoList, (f) => S().groupTabs([f.other], { pinned: false, name: "Reading" })],
  ["moved within the list", intoList, (f) => S().moveTab(f.other, 0)],
  ["unchanged in a folder", intoOuter, () => {}],
  ["grouped inside that folder", intoOuter, (f) => S().groupTabs([f.other], { name: "Sub" })],
]) {
  test(`a confirmed drop before a row that is ${what} lands before it`, async (t) => {
    const f = sidebar();
    const spot = into(f);
    answering(t, true, () => change(f));
    dropGroup(f.team, { ...spot, beforeId: f.other });
    await settle();
    assert.equal(S().groups[f.team].parentId, spot.groupId);
    const order = S().windows[f.w].tabIds;
    assert.equal(order[order.indexOf(f.ids[0]) + 1], f.other);
  });
}

test("a confirmed drop at the end of the list lands there though the last row closed meanwhile", async (t) => {
  const f = sidebar();
  answering(t, true, () => S().closeTab(f.other));
  dropGroup(f.team, { zone: "list", beforeId: null });
  await settle();
  assert.equal(S().groups[f.team].pinned, false);
  assert.equal(S().windows[f.w].tabIds.at(-1), f.ids[0]);
});

test("a confirmed drop before a split row lands though its first pane is outside the folder showing it", async (t) => {
  answering(t, true);
  const f = sidebar();
  S().groupTabs([f.home, f.other], { pinned: true, name: "Outer" });
  const sub = S().groupTabs([f.other], { name: "Sub" });
  const split = { id: "split-across", windowId: f.w, orientation: "horizontal", slots: [f.home, f.other].map((tabId) => ({ tabId, size: 0.5 })) };
  useBrowser.setState((s) => ({ splits: { ...s.splits, [split.id]: split } }));
  dropGroup(f.team, { zone: "group", groupId: sub, beforeId: f.home });
  await settle();
  assert.equal(S().groups[f.team].parentId, sub);
});

test("a confirmed drop out of Pinned is counted once", async (t) => {
  setConsentPeriod(true, "drop-test-confirmed");
  t.after(() => setConsentPeriod(false, null));
  answering(t, true);
  const f = sidebar();
  const outer = S().groupTabs([f.other], { pinned: true, name: "Outer" });
  const counted = devTabPresses().drops_shared_folder_confirmed;
  dropGroup(f.team, { zone: "group", groupId: outer, beforeId: null });
  await settle();
  assert.equal(devTabPresses().drops_shared_folder_confirmed, counted + 1);
});

test("the confirmed move is the user's own write, not a running automation command's", async (t) => {
  answering(t, true);
  const around = foreignWriteHooks.around;
  let writes = 0;
  foreignWriteHooks.around = (write) => (writes++, around(write));
  t.after(() => (foreignWriteHooks.around = around));
  const f = sidebar();
  dropGroup(f.team, { zone: "list", beforeId: null });
  await settle();
  assert.equal(S().groups[f.team].pinned, false);
  assert.equal(writes, 1);
});

test("dragging a link out of a ⌘-click shared folder leaves its subfolder, and the files in it, alone", () => {
  const f = sidebar({ links: 2 });
  const docs = S().groupTabs([f.ids[1]], { name: "Docs" });
  assert.equal(S().groups[docs].parentId, f.team, "setup: Docs is inside the shared folder");
  useBrowser.setState((s) => ({ groups: { ...s.groups, [f.team]: { ...s.groups[f.team], autoUngroup: true } } }));
  const entries = () => localFolder(S(), f.team, knownNames([])).entries;
  const before = entries().filter((e) => e.kind === "dir");
  dropTab(f.ids[0], { zone: "list", beforeId: null });
  assert.equal(S().groups[docs].parentId, f.team);
  assert.deepEqual(S().groups[f.team].tabIds, [f.ids[1]]);
  assert.deepEqual(entries(), before, "the sync engine sees the same Docs and nothing at the root");
  staysShared(f);
});

function emptied() {
  const f = sidebar();
  dropTab(f.ids[0], { zone: "list", beforeId: null });
  return { ...f, row: S().groups[f.team].tabIds[0] };
}

test("the Empty Folder row can't be dropped on the page as a split", () => {
  const f = emptied();
  dropTabIntoSplit(f.row, f.home, "right");
  assert.deepEqual(S().groups[f.team].tabIds, [f.row]);
  assert.equal(Object.values(S().splits).length, 0);
});

test("the Empty Folder row can't be dragged out into a window of its own", () => {
  const f = emptied();
  useBrowser.setState((s) => ({ windows: { ...s.windows, [f.w]: { ...s.windows[f.w], frame: [0, 0, 800, 800] } } }));
  const windows = Object.keys(S().windows).length;
  dropTabsOutside([f.row], f.w, 2000, 300);
  assert.equal(Object.keys(S().windows).length, windows);
  assert.deepEqual(S().groups[f.team].tabIds, [f.row]);
});

test("the Empty Folder row on another profile's icon asks nothing", async (t) => {
  const asked = answering(t, true);
  const f = emptied();
  S().updateSettings({ warnBeforeMovingTabsToProfile: true });
  const to = S().createProfile({ name: "Icon" });
  await dropTabsInProfile([f.row], to, { type: "none" }, f.profileId, true);
  assert.deepEqual(asked, []);
  assert.deepEqual(S().groups[f.team].tabIds, [f.row]);
});

test("a kept folder keeps its subfolder while another nested group exists", () => {
  const f = sidebar({ links: 2 });
  const inside = S().newTab(f.w, { url: `https://inside${runs}.example/`, background: true });
  const outer = S().groupTabs([f.other, inside], { pinned: false, name: "Outer" });
  const inner = S().groupTabs([inside], { name: "Inner" });
  assert.equal(S().groups[inner].parentId, outer, "setup: an unrelated nested group");
  const docs = S().groupTabs([f.ids[1]], { name: "Docs" });
  useBrowser.setState((s) => ({ groups: { ...s.groups, [f.team]: { ...s.groups[f.team], autoUngroup: true } } }));
  dropTab(f.ids[0], { zone: "list", beforeId: null });
  assert.equal(S().groups[docs].parentId, f.team);
  staysShared(f);
});

test("the Empty Folder row never lands between the panes of the split the link made", () => {
  const f = sidebar();
  S().pinTabs([f.other], true, true);
  S().placeTabs([f.other], { pinned: true, row: true, beforeId: f.ids[0] });
  assert.ok(dropTabOnRow(f.ids[0], f.other, "right"), "setup: the link joins the pinned row above its folder");
  const order = S().windows[f.w].tabIds;
  assert.equal(order.indexOf(f.ids[0]), order.indexOf(f.other) + 1);
  assert.deepEqual(rows(f.team), ["Empty Folder"]);
  staysShared(f);
});
