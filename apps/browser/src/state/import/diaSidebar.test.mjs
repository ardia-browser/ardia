import assert from "node:assert/strict";
import { after, test } from "node:test";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { useBrowser } = await import("../browser/store.ts");
const { importDiaSpace } = await import("./sidebarTree.ts");
const { splitTabIds } = await import("../splits/splits.ts");
const { closesWindow, isPinnedRow } = await import("../browser/model.ts");
const { takeImportRuns, noteDiaSidebar } = await import("../telemetry/importRuns.ts");

const S = () => useBrowser.getState();
const P = "default";
const link = (url, title = url, pageTitle) => ({ type: "url", title, url, ...(pageTitle !== undefined ? { pageTitle } : {}) });
const folder = (title, children, extra = {}) => ({ type: "folder", title, children, ...extra });
const split = (...children) => ({ type: "folder", title: "", role: "split", children });
const tab = (url, extra = {}) => ({ url, title: url, pinned: false, windowIndex: 0, active: false, ...extra });

const home = () => ({
  id: "space-home",
  name: "Home",
  profileId: "Default",
  color: "#E3B341",
  favorites: [tab("https://mail.dia.example/", { pinned: true }), tab("https://calendar.dia.example/", { pinned: true })],
  pinned: [
    link("https://docs.dia.example/", "Team docs", "Docs"),
    folder("Reading", [link("https://read.dia.example/one"), folder("Deep", [link("https://read.dia.example/deep")])], { icon: "📚", color: "blue" }),
    split(link("https://left.dia.example/"), link("https://right.dia.example/")),
  ],
  tabs: [tab("https://news.dia.example/story"), tab("https://code.dia.example/", { splitId: "dia-9" }), tab("https://preview.dia.example/", { splitId: "dia-9" })],
  openGroups: [
    folder("Research", [link("https://paper.dia.example/"), folder("Sources", [link("https://source.dia.example/a", "Primary source", "Source A")], { color: "green" })], {
      icon: "🔬",
      color: "purple",
    }),
    folder("Later", [link("https://later.dia.example/")], { icon: "⏰", color: "not-a-colour" }),
  ],
});

function start() {
  S().hydrate({});
  return S().createWindow({ url: "https://start.example/" });
}

const groupsNamed = () => Object.fromEntries(Object.values(S().groups).map((g) => [g.name, g]));
const urlsIn = (g) => g.tabIds.map((id) => S().tabs[id].url);

test("a Dia space's favourites come over as tiles and its pinned tabs as rows, with their custom names", () => {
  start();
  importDiaSpace(P, home());
  const tiles = Object.values(S().tabs).filter((t) => t.pin && !isPinnedRow(t)).map((t) => t.url);
  assert.deepEqual(tiles.sort(), ["https://calendar.dia.example/", "https://mail.dia.example/"]);
  const rows = Object.values(S().tabs).filter((t) => isPinnedRow(t)).map((t) => t.url).sort();
  assert.deepEqual(rows, ["https://docs.dia.example/", "https://left.dia.example/", "https://right.dia.example/"]);
  const docs = Object.values(S().tabs).find((t) => t.url === "https://docs.dia.example/");
  assert.equal(docs.customTitle, "Team docs");
  assert.equal(docs.title, "Docs");
});

test("Dia's pinned folders become pinned groups and its open-tab groups list groups, nested, named, with emoji and colour", () => {
  start();
  const r = importDiaSpace(P, home());
  const g = groupsNamed();
  assert.equal(g.Reading.pinned, true);
  assert.equal(g.Deep.pinned, true);
  assert.equal(g.Deep.parentId, g.Reading.id);
  assert.equal(g.Reading.icon, "📚");
  assert.equal(g.Reading.color, "blue");
  assert.equal(g.Deep.icon, null);
  assert.equal(g.Research.pinned, false);
  assert.equal(g.Sources.pinned, false);
  assert.equal(g.Sources.parentId, g.Research.id);
  assert.equal([g.Research.icon, g.Research.color].join(" "), "🔬 purple");
  assert.equal(g.Sources.color, "green");
  assert.equal(g.Later.color, null, "a colour Ardia has no swatch for is left out");
  assert.deepEqual(urlsIn(g.Research), ["https://paper.dia.example/", "https://source.dia.example/a"]);
  assert.equal(S().tabs[g.Sources.tabIds[0]].customTitle, "Primary source");
  assert.ok(Object.values(g).every((x) => x.name === "Imported" || x.collapsed), "imported folders and groups come in closed");
  assert.equal(r.groups, 5);
});

test("Dia's pinned rows, folders and splits keep their order in the pinned section", () => {
  const w = start();
  importDiaSpace(P, home());
  const pinnedArea = new Set(Object.values(S().groups).filter((g) => g.pinned).flatMap((g) => g.tabIds));
  const pinned = S().windows[w].tabIds.filter((id) => isPinnedRow(S().tabs[id]) || pinnedArea.has(id)).map((id) => S().tabs[id].url);
  assert.deepEqual(pinned, [
    "https://docs.dia.example/",
    "https://read.dia.example/one",
    "https://read.dia.example/deep",
    "https://left.dia.example/",
    "https://right.dia.example/",
  ]);
});

test("with a small window focused, every part of a Dia sidebar lands in one main window", () => {
  const w = start();
  const small = S().createWindow({ kind: "small", url: "https://little.example/" });
  S().setFocusedWindow(small);
  const space = home();
  space.pinned.push(link("https://after.dia.example/"));
  importDiaSpace(P, space);
  const imported = Object.values(S().tabs).filter((t) => t.url.includes(".dia.example/"));
  assert.ok(imported.length > 0);
  assert.deepEqual([...new Set(imported.map((t) => t.windowId))], [w]);
  assert.deepEqual([...new Set(Object.values(S().groups).map((g) => g.windowId))], [w]);
});

test("an open-tabs import of one Dia group keeps its window when the starting tab closes", () => {
  const w = start();
  const first = S().windows[w].tabIds[0];
  importDiaSpace(P, { id: "s", name: "Home", profileId: "Default", pinned: [], tabs: [], openGroups: [folder("Only", [link("https://only.dia.example/")])] });
  assert.equal(closesWindow(S(), first), false);
});

test("a custom name over an empty page title is kept for pinned rows and grouped tabs", () => {
  start();
  importDiaSpace(P, {
    id: "s", name: "Home", profileId: "Default", tabs: [],
    pinned: [link("https://blank.dia.example/", "Named row", "")],
    openGroups: [folder("G", [link("https://blank-group.dia.example/", "Named tab", "")])],
  });
  const byUrl = (url) => Object.values(S().tabs).find((t) => t.url === url);
  assert.equal(byUrl("https://blank.dia.example/").customTitle, "Named row");
  assert.equal(byUrl("https://blank-group.dia.example/").customTitle, "Named tab");
});

test("only Dia's ungrouped open tabs go into Imported, its split views come over as splits", () => {
  const w = start();
  const r = importDiaSpace(P, home());
  const g = groupsNamed();
  assert.deepEqual(urlsIn(g.Imported), ["https://news.dia.example/story", "https://code.dia.example/", "https://preview.dia.example/"]);
  const splits = Object.values(S().splits).map((sp) => splitTabIds(sp).map((id) => S().tabs[id].url).sort());
  assert.deepEqual(splits.sort(), [["https://code.dia.example/", "https://preview.dia.example/"], ["https://left.dia.example/", "https://right.dia.example/"]]);
  assert.equal(r.splits, 2);
  assert.equal(r.tabs, 13);
  const list = S().windows[w].tabIds.filter((id) => !S().tabs[id].pin && !Object.values(S().groups).some((x) => x.pinned && x.tabIds.includes(id)));
  const firstOf = (name) => list.indexOf(g[name].tabIds[0]);
  assert.ok(firstOf("Research") === 0 && firstOf("Research") < firstOf("Later"), "Dia's groups lead the list in Dia's order");
});

test("importing the same Dia space again adds no page twice", () => {
  start();
  importDiaSpace(P, home());
  const before = Object.keys(S().tabs).length;
  assert.equal(importDiaSpace(P, home()).tabs, 0);
  assert.equal(Object.keys(S().tabs).length, before);
});

test("an open tab already pinned in Dia comes over once", () => {
  start();
  const space = home();
  space.openGroups[1].children.push(link("https://docs.dia.example/"));
  importDiaSpace(P, space);
  assert.equal(Object.values(S().tabs).filter((t) => t.url === "https://docs.dia.example/").length, 1);
});

test("the hourly import counts carry where Dia's sidebar came from, and reset", () => {
  takeImportRuns();
  noteDiaSidebar({ file: true, unreadable: false, appleScript: false, groups: 5, ownProfiles: 1 });
  noteDiaSidebar({ file: false, unreadable: true, appleScript: true, groups: 0, ownProfiles: 0 });
  const taken = takeImportRuns();
  assert.deepEqual(
    [taken.import_dia_sidebar_files, taken.import_dia_sidebar_unreadable, taken.import_dia_applescript_profiles, taken.import_dia_groups, taken.import_dia_space_profiles],
    [1, 1, 1, 5, 1],
  );
  assert.equal(takeImportRuns().import_dia_groups, 0);
});
