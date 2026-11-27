import assert from "node:assert/strict";
import { after, test } from "node:test";
globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("../telemetry/client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { useBrowser } = await import("../browser/store.ts");
const { importBookmarks } = await import("./apply.ts");
const { countedPages, EDGE_WORK_BUDGET } = await import("./bookmarkMerge.ts");
const { bookmarkRoots } = await import("../bookmarks/bookmarks.ts");
const { takeImportRuns } = await import("../telemetry/importRuns.ts");
const { pageKey } = await import("../tabs/pageKeys.ts");
const { engineProfile } = await import("../browser/model.ts");

const S = () => useBrowser.getState();
const P = "default";
const link = (title, url) => ({ type: "url", title, url });
const folder = (title, children) => ({ type: "folder", title, children });

function tree(id) {
  const node = S().bookmarks.nodes[id];
  if (node.kind === "url") return node.url;
  return [node.title, node.children.map(tree)];
}

const bar = () => tree(bookmarkRoots(S(), P).bar)[1];
const other = () => tree(bookmarkRoots(S(), P).other)[1];

const dia = (bar, others = []) => ({
  type: "folder",
  title: "",
  children: [
    { type: "folder", title: "Bookmarks bar", role: "toolbar", children: bar },
    { type: "folder", title: "Other bookmarks", role: "other", children: others },
  ],
});

const DIA_BAR = [link("Mail", "https://mail.example/"), folder("Work", [link("Docs", "https://docs.example/"), link("Wiki", "https://wiki.example/")])];

function start(...ownLinks) {
  stub.docs.delete("imported-bookmarks.json");
  useBrowser.setState({ bookmarks: { nodes: {} } });
  S().hydrate({});
  S().createWindow({ url: "https://home.example/" });
  S().addBookmarkTree(P, []);
  for (const [title, url] of ownLinks) S().addBookmark({ profileId: P, title, url });
  takeImportRuns();
}

test("importing the same Dia bookmarks again adds no second Imported from Dia folder (#2389)", async () => {
  start(["Mine", "https://mine.example/"]);
  assert.equal(await importBookmarks(P, dia(DIA_BAR, [link("Later", "https://later.example/")]), "Dia"), 4);
  const first = { bar: bar(), other: other() };
  assert.deepEqual(first.bar, ["https://mine.example/", ["Imported from Dia", ["https://mail.example/", ["Work", ["https://docs.example/", "https://wiki.example/"]]]]]);
  takeImportRuns();
  for (let run = 0; run < 3; run++) assert.equal(await importBookmarks(P, dia(DIA_BAR, [link("Later", "https://later.example/")]), "Dia"), 0);
  assert.deepEqual({ bar: bar(), other: other() }, first, "the bar and Other Bookmarks are unchanged");
  const counts = takeImportRuns();
  assert.equal(counts.import_bookmarks_already_there, 12);
  assert.equal(counts.import_bookmark_folders_reused, 0, "an import that adds nothing reuses no folder");
});

test("a repeat import of bookmarks that went straight onto an empty bar adds nothing (#2389)", async () => {
  start();
  assert.equal(await importBookmarks(P, dia(DIA_BAR), "Dia"), 3);
  const first = bar();
  assert.deepEqual(first, ["https://mail.example/", ["Work", ["https://docs.example/", "https://wiki.example/"]]]);
  assert.equal(await importBookmarks(P, dia(DIA_BAR), "Dia"), 0);
  assert.deepEqual(bar(), first);
});

test("a repeat import brings only what's new, into the folders it made, and keeps what the person added or moved (#2389)", async () => {
  start(["Mine", "https://mine.example/"]);
  await importBookmarks(P, dia(DIA_BAR), "Dia");
  const roots = bookmarkRoots(S(), P);
  const imported = S().bookmarks.nodes[roots.bar].children.find((id) => S().bookmarks.nodes[id].title === "Imported from Dia");
  const work = S().bookmarks.nodes[imported].children.find((id) => S().bookmarks.nodes[id].title === "Work");
  S().addBookmark({ profileId: P, title: "Added by hand", url: "https://by-hand.example/", parentId: work });
  const mail = S().bookmarks.nodes[imported].children.find((id) => S().bookmarks.nodes[id].kind === "url");
  S().moveBookmark(mail, roots.other);
  const grown = [...DIA_BAR, link("News", "https://news.example/")];
  grown[1] = folder("Work", [...DIA_BAR[1].children, link("Plan", "https://plan.example/")]);
  assert.equal(await importBookmarks(P, dia(grown), "Dia"), 2);
  assert.deepEqual(bar(), [
    "https://mine.example/",
    ["Imported from Dia", [["Work", ["https://docs.example/", "https://wiki.example/", "https://by-hand.example/", "https://plan.example/"]], "https://news.example/"]],
  ]);
  assert.deepEqual(other(), ["https://mail.example/"], "a bookmark moved out of the import isn't brought back");
});

test("an import from another browser still gets its own folder, and leaves out only the pages the profile already has", async () => {
  start(["Mine", "https://mine.example/"]);
  await importBookmarks(P, dia(DIA_BAR), "Dia");
  assert.equal(await importBookmarks(P, dia([link("Docs", "https://DOCS.example/#"), link("Chrome only", "https://chrome.example/")]), "Chrome"), 1);
  assert.deepEqual(bar().at(-1), ["Imported from Chrome", ["https://chrome.example/"]]);
  assert.equal(bar().filter((n) => Array.isArray(n) && n[0] === "Imported from Dia").length, 1);
});

test("the source's own repeated links and empty folders still come over on a first import", async () => {
  start();
  const twice = [link("A", "https://a.example/"), folder("Again", [link("A", "https://a.example/")]), folder("Empty", [])];
  assert.equal(await importBookmarks(P, dia(twice), "Dia"), 2);
  assert.deepEqual(bar(), ["https://a.example/", ["Again", ["https://a.example/"]], ["Empty", []]]);
  assert.equal(await importBookmarks(P, dia(twice), "Dia"), 0);
  assert.equal(bar().length, 3);
});

const childNamed = (parentId, title) => S().bookmarks.nodes[parentId].children.find((id) => S().bookmarks.nodes[id].title === title);
const barId = () => bookmarkRoots(S(), P).bar;

test("two folders of the same name each take their own new links, matched by the links they share", async () => {
  start(["Mine", "https://mine.example/"]);
  const nested = (extraA = [], extraB = []) => [folder("Top", [folder("Same", [link("A", "https://a.example/"), ...extraA]), folder("Same", [link("B", "https://b.example/"), ...extraB])])];
  await importBookmarks(P, dia(nested()), "Dia");
  assert.equal(await importBookmarks(P, dia(nested([link("A2", "https://a2.example/")], [link("B2", "https://b2.example/")])), "Dia"), 2);
  assert.deepEqual(bar()[1], ["Imported from Dia", [["Top", [["Same", ["https://a.example/", "https://a2.example/"]], ["Same", ["https://b.example/", "https://b2.example/"]]]]]]);
});

test("a folder that went straight onto the bar keeps taking its new links after a later import made an Imported from folder", async () => {
  start();
  const work = (...more) => folder("Work", [link("Docs", "https://docs.example/"), link("Wiki", "https://wiki.example/"), ...more]);
  await importBookmarks(P, dia([work()]), "Dia");
  await importBookmarks(P, dia([work(link("Plan", "https://plan.example/")), link("News", "https://news.example/")]), "Dia");
  await importBookmarks(P, dia([work(link("Plan", "https://plan.example/"), link("Ship", "https://ship.example/")), link("News", "https://news.example/")]), "Dia");
  assert.deepEqual(bar(), [
    ["Work", ["https://docs.example/", "https://wiki.example/", "https://plan.example/", "https://ship.example/"]],
    ["Imported from Dia", ["https://news.example/"]],
  ]);
});

test("another browser's folder that shares a link with one an earlier import put on the bar gets its own Imported from folder", async () => {
  start();
  await importBookmarks(P, dia([folder("Work", [link("Docs", "https://docs.example/"), link("Wiki", "https://wiki.example/")])]), "Dia");
  assert.equal(await importBookmarks(P, dia([folder("Work", [link("Docs", "https://docs.example/"), link("Chrome", "https://chrome.example/"), link("Mail", "https://mail.example/")])]), "Chrome"), 2);
  assert.deepEqual(bar(), [
    ["Work", ["https://docs.example/", "https://wiki.example/"]],
    ["Imported from Chrome", [["Work", ["https://chrome.example/", "https://mail.example/"]]]],
  ]);
});

test("folders with no links come over: on a first import, and as a new folder in a repeat whose links are all there", async () => {
  start();
  assert.equal(await importBookmarks(P, dia([folder("Empty", []), folder("Also empty", [])]), "Dia"), 0);
  assert.deepEqual(bar(), [["Empty", []], ["Also empty", []]]);
  assert.equal(await importBookmarks(P, dia([folder("Empty", []), folder("Also empty", [])]), "Dia"), 0);
  assert.equal(bar().length, 2, "and aren't made twice");
  start(["Mine", "https://mine.example/"]);
  await importBookmarks(P, dia(DIA_BAR), "Dia");
  await importBookmarks(P, dia([...DIA_BAR, folder("Ideas", [])]), "Dia");
  assert.deepEqual(bar()[1][1].at(-1), ["Ideas", []]);
  await importBookmarks(P, dia([...DIA_BAR, folder("Ideas", [])]), "Dia");
  assert.equal(bar()[1][1].filter((n) => Array.isArray(n) && n[0] === "Ideas").length, 1);
});

test("a link with the scheme's default port is the page already bookmarked without it", async () => {
  start(["Port", "https://port.example/"], ["Plain", "http://plain.example/a"]);
  assert.equal(await importBookmarks(P, dia([link("Port", "https://port.example:443/"), link("Plain", "HTTP://Plain.Example:80/a"), link("Other port", "https://port.example:8443/")]), "Dia"), 1);
  assert.deepEqual(bar().at(-1), ["Imported from Dia", ["https://port.example:8443/"]]);
});

test("a repeat import that adds one link to each of 1,500 folders writes the store once", async () => {
  start(["Mine", "https://mine.example/"]);
  const folders = (extra) => Array.from({ length: 1500 }, (_, i) => folder(`F${i}`, [link("a", `https://f${i}.example/a`), ...(extra ? [link("b", `https://f${i}.example/b`)] : [])]));
  await importBookmarks(P, dia(folders(false)), "Dia");
  let writes = 0;
  const stop = useBrowser.subscribe((s, prev) => {
    if (s.bookmarks !== prev.bookmarks) writes += 1;
  });
  const began = performance.now();
  assert.equal(await importBookmarks(P, dia(folders(true)), "Dia"), 1500);
  const took = performance.now() - began;
  stop();
  assert.equal(writes, 1);
  assert.ok(took < 2000, `took ${took} ms`);
  const wrapper = childNamed(barId(), "Imported from Dia");
  assert.equal(S().bookmarks.nodes[wrapper].children.length, 1500, "every folder took its link in place");
});

test("Imported from folders reused counts each import that added to a folder an earlier one made, and no other", async () => {
  start(["Mine", "https://mine.example/"]);
  await importBookmarks(P, dia(DIA_BAR), "Dia");
  takeImportRuns();
  await importBookmarks(P, dia(DIA_BAR), "Dia");
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 0, "nothing added");
  await importBookmarks(P, dia([...DIA_BAR, link("News", "https://news.example/")]), "Dia");
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 1, "added to Imported from Dia");
  start();
  await importBookmarks(P, dia(DIA_BAR), "Dia");
  takeImportRuns();
  await importBookmarks(P, dia([DIA_BAR[0], folder("Work", [...DIA_BAR[1].children, link("Plan", "https://plan.example/")])]), "Dia");
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 1, "added to a folder an earlier import put straight on the bar");
  await importBookmarks(P, dia([link("Fresh", "https://fresh.example/")]), "Chrome");
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 0, "a new Imported from folder isn't a reused one");
});

test("another browser's folder that went straight onto the bar never takes a Dia import, even when Dia's folder holds all its links", async () => {
  start();
  await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/")])]), "Chrome");
  assert.equal(await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/"), link("B", "https://b.example/")])]), "Dia"), 1);
  assert.deepEqual(bar(), [
    ["Work", ["https://a.example/"]],
    ["Imported from Dia", [["Work", ["https://b.example/"]]]],
  ]);
});

test("an empty folder an import put on the bar takes the links the source adds to it later", async () => {
  start();
  await importBookmarks(P, dia([folder("Work", []), link("Mail", "https://mail.example/")]), "Dia");
  assert.equal(await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/")]), link("Mail", "https://mail.example/")]), "Dia"), 1);
  assert.deepEqual(bar(), [["Work", ["https://a.example/"]], "https://mail.example/"]);
  start(["Mine", "https://mine.example/"]);
  await importBookmarks(P, dia([folder("Later", [])]), "Dia");
  await importBookmarks(P, dia([folder("Later", [link("Read", "https://read.example/")])]), "Dia");
  assert.deepEqual(bar()[1], ["Imported from Dia", [["Later", ["https://read.example/"]]]]);
});

test("which folders an import made is saved, so a relaunch keeps matching them", async () => {
  start();
  await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/")])]), "Dia");
  const saved = JSON.parse(stub.docs.get("imported-bookmarks.json"));
  const work = childNamed(barId(), "Work");
  assert.deepEqual(saved.folders[work], { source: "Dia", engine: engineProfile(S(), P) });
  assert.equal(saved.version, 1);
  const nodes = structuredClone(S().bookmarks.nodes);
  useBrowser.setState({ bookmarks: { nodes } });
  await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/"), link("B", "https://b.example/")])]), "Dia");
  assert.deepEqual(bar(), [["Work", ["https://a.example/", "https://b.example/"]]]);
});

test("folders of the same name are matched as a whole, so one that shares a link with both doesn't take the other's", async () => {
  start(["Mine", "https://mine.example/"]);
  await importBookmarks(P, dia([folder("Same", [link("Shared", "https://shared.example/"), link("A", "https://a.example/")]), folder("Same", [link("Shared", "https://shared.example/"), link("B", "https://b.example/")])]), "Dia");
  await importBookmarks(P, dia([folder("Same", [link("Shared", "https://shared.example/"), link("New B", "https://new-b.example/")]), folder("Same", [link("A", "https://a.example/"), link("New A", "https://new-a.example/")])]), "Dia");
  assert.deepEqual(bar()[1], [
    "Imported from Dia",
    [
      ["Same", ["https://shared.example/", "https://a.example/", "https://new-a.example/"]],
      ["Same", ["https://shared.example/", "https://b.example/", "https://new-b.example/"]],
    ],
  ]);
});

test("3,000 folders of the same name each take their own new link, in one store write", async () => {
  start(["Mine", "https://mine.example/"]);
  const siblings = (extra) => Array.from({ length: 3000 }, (_, i) => folder("Folder", [link("a", `https://s${i}.example/a`), ...(extra ? [link("b", `https://s${i}.example/b`)] : [])]));
  await importBookmarks(P, dia(siblings(false)), "Dia");
  let writes = 0;
  const stop = useBrowser.subscribe((s, prev) => {
    if (s.bookmarks !== prev.bookmarks) writes += 1;
  });
  const began = performance.now();
  assert.equal(await importBookmarks(P, dia(siblings(true)), "Dia"), 3000);
  const took = performance.now() - began;
  stop();
  assert.equal(writes, 1);
  assert.ok(took < 3000, `took ${took} ms`);
  const wrapper = childNamed(barId(), "Imported from Dia");
  const nodes = S().bookmarks.nodes;
  assert.equal(nodes[wrapper].children.length, 3000);
  assert.ok(nodes[wrapper].children.every((id, i) => nodes[id].children.map((c) => nodes[c].url).join(" ") === `https://s${i}.example/a https://s${i}.example/b`));
});

test("a port written with leading zeros is the scheme's default port, or the same port without them", async () => {
  assert.equal(pageKey("https://Port.example:0443/"), "https://port.example/");
  assert.equal(pageKey("http://port.example:080/x"), "http://port.example/x");
  assert.equal(pageKey("https://port.example:08443/"), "https://port.example:8443/");
  assert.equal(pageKey("https://port.example:/"), "https://port.example/");
  assert.equal(pageKey("https://user:Pw@[::1]:0443/"), "https://user:Pw@[::1]/");
  start(["Port", "https://port.example/"], ["Other", "https://port.example:8443/"]);
  assert.equal(await importBookmarks(P, dia([link("Port", "https://port.example:0443/"), link("Other", "https://port.example:08443/")]), "Dia"), 0);
});

test("a folder someone named Imported from Dia by hand takes the import but never counts as one an import made, and an empty folder added to one an import made counts", async () => {
  start();
  S().addBookmarkFolder({ profileId: P, title: "Imported from Dia" });
  takeImportRuns();
  await importBookmarks(P, dia([link("A", "https://a.example/")]), "Dia");
  assert.deepEqual(bar(), [["Imported from Dia", ["https://a.example/"]]]);
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 0);
  await importBookmarks(P, dia([link("A", "https://a.example/"), folder("Ideas", [])]), "Dia");
  assert.deepEqual(bar(), [["Imported from Dia", ["https://a.example/", ["Ideas", []]]]]);
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 0, "still the folder made by hand");
  start(["Mine", "https://mine.example/"]);
  await importBookmarks(P, dia([link("A", "https://a.example/")]), "Dia");
  takeImportRuns();
  await importBookmarks(P, dia([link("A", "https://a.example/"), folder("Ideas", [])]), "Dia");
  assert.deepEqual(bar()[1], ["Imported from Dia", ["https://a.example/", ["Ideas", []]]]);
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 1, "an empty folder added to the folder an import made");
});

const wrapperFolders = () => {
  const nodes = S().bookmarks.nodes;
  const wrapper = childNamed(barId(), "Imported from Dia");
  return nodes[wrapper].children.filter((id) => nodes[id].kind === "folder").map((id) => nodes[id].children.map((c) => nodes[c].url));
};

test("18 folders of the same name that share most of their links each take their own new link, whatever order they come in", async () => {
  start(["Mine", "https://mine.example/"]);
  const pages = Array.from({ length: 18 }, (_, i) => `https://common${i}.example/`);
  const without = (i) => pages.filter((_, j) => j !== i).map((url) => link("c", url));
  await importBookmarks(P, dia(pages.map((_, i) => folder("Same", without(i)))), "Dia");
  const reversed = pages.map((_, i) => 17 - i).map((i) => folder("Same", [...without(i), link("new", `https://new${i}.example/`)]));
  assert.equal(await importBookmarks(P, dia(reversed), "Dia"), 18);
  wrapperFolders().forEach((urls, i) => assert.deepEqual(urls, [...pages.filter((_, j) => j !== i), `https://new${i}.example/`], `folder ${i}`));
});

test("65 folders of the same name linked in a ring of shared pages are all paired by their links, not by position", async () => {
  start(["Mine", "https://mine.example/"]);
  const u = (j) => `https://u${j}.example/`;
  const v = (j) => `https://v${j}.example/`;
  await importBookmarks(P, dia(Array.from({ length: 65 }, (_, j) => folder("Same", [link("u", u(j)), link("v", v(j))]))), "Dia");
  const incoming = Array.from({ length: 65 }, (_, i) =>
    folder("Same", i === 64 ? [link("u", u(0)), link("new", `https://new${i}.example/`)] : [link("v", v(i)), link("u", u(i + 1)), link("new", `https://new${i}.example/`)]),
  );
  assert.equal(await importBookmarks(P, dia(incoming), "Dia"), 65);
  wrapperFolders().forEach((urls, j) => assert.deepEqual(urls, [u(j), v(j), `https://new${(j + 64) % 65}.example/`], `folder ${j}`));
});

test("another browser's folder moved into Imported from Dia doesn't take a Dia import", async () => {
  start();
  await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/")])]), "Chrome");
  await importBookmarks(P, dia([link("Mail", "https://mail.example/")]), "Dia");
  const chromeWork = childNamed(barId(), "Work");
  S().moveBookmark(chromeWork, childNamed(barId(), "Imported from Dia"));
  assert.equal(await importBookmarks(P, dia([link("Mail", "https://mail.example/"), folder("Work", [link("A", "https://a.example/"), link("B", "https://b.example/")])]), "Dia"), 1);
  assert.deepEqual(bar(), [["Imported from Dia", ["https://mail.example/", ["Work", ["https://a.example/"]], ["Work", ["https://b.example/"]]]]]);
});

test("3,000 folders of the same name that all hold one common page still pair by their own pages, quickly", async () => {
  start(["Mine", "https://mine.example/"]);
  const siblings = (extra) =>
    Array.from({ length: 3000 }, (_, i) => folder("Folder", [link("common", "https://common.example/"), link("a", `https://s${i}.example/a`), ...(extra ? [link("b", `https://s${i}.example/b`)] : [])]));
  await importBookmarks(P, dia(siblings(false)), "Dia");
  const began = performance.now();
  assert.equal(await importBookmarks(P, dia(siblings(true).reverse()), "Dia"), 3000);
  assert.ok(performance.now() - began < 3000, `took ${performance.now() - began} ms`);
  wrapperFolders().forEach((urls, i) => assert.deepEqual(urls, ["https://common.example/", `https://s${i}.example/a`, `https://s${i}.example/b`]));
});

test("a folder another browser's import made keeps that browser's name on it when moved out of its parent into Imported from Dia", async () => {
  start();
  await importBookmarks(P, dia([folder("Outer", [folder("Work", [link("A", "https://a.example/")])])]), "Chrome");
  await importBookmarks(P, dia([link("Mail", "https://mail.example/")]), "Dia");
  const work = childNamed(childNamed(barId(), "Outer"), "Work");
  S().moveBookmark(work, childNamed(barId(), "Imported from Dia"));
  assert.equal(await importBookmarks(P, dia([link("Mail", "https://mail.example/"), folder("Work", [link("A", "https://a.example/"), link("B", "https://b.example/")])]), "Dia"), 1);
  assert.deepEqual(bar(), [["Outer", []], ["Imported from Dia", ["https://mail.example/", ["Work", ["https://a.example/"]], ["Work", ["https://b.example/"]]]]]);
});

test("a folder an import from before this fix put on the bar takes the links its source adds, while a folder of the same name made by hand doesn't", async () => {
  start();
  S().addBookmarkTree(P, [{ title: "Work", children: [{ title: "A", url: "https://a.example/" }] }, { title: "Notes", children: [{ title: "X", url: "https://x.example/" }] }], bookmarkRoots(S(), P).bar);
  assert.equal(await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/"), link("B", "https://b.example/")])]), "Dia"), 1);
  assert.deepEqual(bar(), [["Work", ["https://a.example/", "https://b.example/"]], ["Notes", ["https://x.example/"]]]);
  assert.equal(await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/"), link("B", "https://b.example/"), link("C", "https://c.example/")]), folder("Notes", [link("Y", "https://y.example/")])]), "Dia"), 2);
  assert.deepEqual(bar(), [
    ["Work", ["https://a.example/", "https://b.example/", "https://c.example/"]],
    ["Notes", ["https://x.example/"]],
    ["Imported from Dia", [["Notes", ["https://y.example/"]]]],
  ]);
});

test("a page too costly to count doesn't stop cheaper evidence after it from counting", async () => {
  const holders = new Map([
    ["a-common", Array.from({ length: 709 }, (_, i) => i)],
    ["z-key", Array.from({ length: 709 }, (_, i) => i)],
  ]);
  const pagesOf = Array.from({ length: 709 }, (_, i) => (i === 0 ? ["a-common", "z-key"] : ["a-common"]));
  assert.ok(709 * 709 > EDGE_WORK_BUDGET);
  assert.deepEqual([...countedPages(pagesOf, holders)], ["z-key"]);
});

test("1,000 folders of the same name holding 150 pages, each page in 16 existing folders, stay within the matching budget", async () => {
  start(["Mine", "https://mine.example/"]);
  const page = (p) => link("p", `https://p${p}.example/`);
  await importBookmarks(P, dia(Array.from({ length: 2400 }, (_, j) => folder("Same", [page(Math.floor(j / 16)), link("own", `https://own${j}.example/`)]))), "Dia");
  const began = performance.now();
  const all = Array.from({ length: 150 }, (_, p) => page(p));
  assert.equal(await importBookmarks(P, dia(Array.from({ length: 1000 }, (_, i) => folder("Same", [...all, link("new", `https://new${i}.example/`)]))), "Dia"), 1000);
  assert.ok(performance.now() - began < 5000, `took ${performance.now() - began} ms`);
  const folders = wrapperFolders();
  assert.equal(folders.reduce((n, urls) => n + urls.filter((u) => u.startsWith("https://new")).length, 0), 1000);
});

test("a folder an import made inside an Imported from Dia folder made by hand counts as reused when it takes more", async () => {
  start();
  S().addBookmarkFolder({ profileId: P, title: "Imported from Dia" });
  await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/")])]), "Dia");
  takeImportRuns();
  await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/"), link("B", "https://b.example/")])]), "Dia");
  assert.deepEqual(bar(), [["Imported from Dia", [["Work", ["https://a.example/", "https://b.example/"]]]]]);
  assert.equal(takeImportRuns().import_bookmark_folders_reused, 1);
});

test("1,001 folders of the same name linked in a ring of shared pages, past the exact pairing's limit, still all pair by their links", async () => {
  start(["Mine", "https://mine.example/"]);
  const n = 1001;
  const u = (j) => `https://u${j}.example/`;
  const v = (j) => `https://v${j}.example/`;
  await importBookmarks(P, dia(Array.from({ length: n }, (_, j) => folder("Same", [link("u", u(j)), link("v", v(j))]))), "Dia");
  const incoming = Array.from({ length: n }, (_, i) =>
    folder("Same", i === n - 1 ? [link("u", u(0)), link("new", `https://new${i}.example/`)] : [link("v", v(i)), link("u", u(i + 1)), link("new", `https://new${i}.example/`)]),
  );
  const began = performance.now();
  assert.equal(await importBookmarks(P, dia(incoming), "Dia"), n);
  assert.ok(performance.now() - began < 3000, `took ${performance.now() - began} ms`);
  wrapperFolders().forEach((urls, j) => assert.deepEqual(urls, [u(j), v(j), `https://new${(j + n - 1) % n}.example/`], `folder ${j}`));
});

test("a folder another browser's import nested inside its own Imported from folder doesn't take a Dia import after it is moved", async () => {
  start(["Mine", "https://mine.example/"]);
  await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/")])]), "Chrome");
  await importBookmarks(P, dia([link("Mail", "https://mail.example/")]), "Dia");
  const chromeWork = childNamed(childNamed(barId(), "Imported from Chrome"), "Work");
  S().moveBookmark(chromeWork, childNamed(barId(), "Imported from Dia"));
  assert.equal(await importBookmarks(P, dia([link("Mail", "https://mail.example/"), folder("Work", [link("A", "https://a.example/"), link("B", "https://b.example/")])]), "Dia"), 1);
  assert.deepEqual(bar().at(-1), ["Imported from Dia", ["https://mail.example/", ["Work", ["https://a.example/"]], ["Work", ["https://b.example/"]]]]);
});

test("an import that adds nothing to a folder from before this fix doesn't claim it for its browser", async () => {
  start();
  S().addBookmarkTree(P, [{ title: "Work", children: [{ title: "A", url: "https://a.example/" }] }], bookmarkRoots(S(), P).bar);
  assert.equal(await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/")])]), "Chrome"), 0);
  assert.deepEqual(JSON.parse(stub.docs.get("imported-bookmarks.json") ?? '{"folders":{}}').folders, {}, "Chrome claimed nothing");
  assert.equal(await importBookmarks(P, dia([folder("Work", [link("A", "https://a.example/"), link("B", "https://b.example/")])]), "Dia"), 1);
  assert.deepEqual(bar(), [["Work", ["https://a.example/", "https://b.example/"]]]);
});
