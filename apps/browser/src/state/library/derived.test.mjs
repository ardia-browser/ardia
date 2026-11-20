import assert from "node:assert/strict";
import { test } from "node:test";

const derived = await import("./derived.ts");
const items = await import("./items.ts");
const scope = await import("./profileScope.ts");
const { sameDaySlot } = await import("../../components/library/dayLayout.ts");
const { downloadById } = await import("../downloads/hooks.ts");
const downloadsSlice = await import("../downloads/downloadsSlice.ts");

const { libraryMediaOf, libraryDownloadsOf, downloadsOwnedIn } = derived;
const { refinedSearch, searchItems, primeSearchText } = items;
const { profileOwners, sharedProfileOwners, scopedHistory, profileSearchOf, mergedHistory } = scope;

const PROFILES = {
  default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 },
  work: { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 },
  studio: { id: "studio", name: "Studio", color: "green", icon: null, createdAt: 2 },
};
const ORDER = ["default", "work", "studio"];
const ENGINES = ["", "work", "studio"];
const KINDS = ["all", "image", "video", "audio"];
const EXT = [".jpg", ".mp4", ".mp3", ".pdf"];

const download = (i) => ({
  id: `d${i}`, url: `https://dl${i % 5}.example/${i}`, filename: `file-${i}${EXT[i % 4]}`, path: `/Downloads/${ENGINES[i % 3] || "p"}/file-${i}${EXT[i % 4]}`,
  state: i % 7 === 0 ? "failed" : i % 11 === 0 ? "cancelled" : "finished", paused: false, received: 1, total: 1, speed: 0, mimeType: "", profile: ENGINES[i % 3], startTime: 1_000_000 - i * 1000,
});
const DOWNLOADS = Array.from({ length: 600 }, (_, i) => download(i));
const LISTINGS = ENGINES.map((engine, n) => ({
  folder: `/Downloads/${engine || "p"}`,
  engines: [engine],
  files: Array.from({ length: 80 }, (_, i) => ({ path: `/Downloads/${engine || "p"}/folder-${i}${EXT[i % 3]}`, name: `folder-${i}${EXT[i % 3]}`, kind: ["image", "video", "audio"][i % 3], added: 1_000_500 - i * 3000 - n, size: 1 })),
}));
const visit = (url, title, lastVisit) => ({ url, title, favicon: null, visits: 1, lastVisit });

const newestFirst = (list) => list.every((item, i) => i === 0 || (list[i - 1].at ?? Infinity) >= (item.at ?? Infinity));
const ownedOnlyBy = (item, profile) => item.owners?.length === 1 && item.owners[0] === profile;

test("Media lists only finished files of the chosen kind and profile, newest first, and a filter flipped back reuses its list", () => {
  const owners = sharedProfileOwners({ profiles: PROFILES, profileOrder: ORDER });
  const owned = downloadsOwnedIn(DOWNLOADS, owners);
  const everyFolderFile = LISTINGS.reduce((n, l) => n + l.files.length, 0);
  const all = libraryMediaOf(owned, LISTINGS, "all", owners, null);
  assert.equal(all.filter((m) => m.id.startsWith("file:")).length, everyFolderFile, "every folder file shows under All in every profile");
  assert.ok(all.every((m) => m.id.startsWith("file:") || m.download.state === "finished"), "only finished downloads");
  assert.ok(!all.some((m) => m.download.filename.endsWith(".pdf")), "no documents");
  for (const profile of [null, ...ORDER])
    for (const kind of KINDS) {
      const listed = libraryMediaOf(owned, LISTINGS, kind, owners, profile);
      assert.ok(listed.length > 0, `${kind} in ${profile ?? "every profile"}`);
      assert.ok(kind === "all" || listed.every((m) => m.media === kind), `${kind} holds only ${kind}`);
      assert.ok(profile === null || listed.every((m) => ownedOnlyBy(m, profile)), `${profile} holds only its own`);
      assert.ok(newestFirst(listed));
      assert.equal(libraryMediaOf(owned, LISTINGS, kind, owners, profile), listed, "flipping back costs nothing");
    }
  assert.ok(libraryMediaOf(DOWNLOADS, LISTINGS.slice(0, 1), "image", null, null).every((m) => m.owners === undefined), "one profile's Library has no owners");
});

test("Downloads list every download but the cancelled, each in its own profile, and a profile flipped back reuses its list", () => {
  const owners = sharedProfileOwners({ profiles: PROFILES, profileOrder: ORDER });
  const owned = downloadsOwnedIn(DOWNLOADS, owners);
  const all = libraryDownloadsOf(owned, owners, null);
  assert.equal(all.length, DOWNLOADS.filter((d) => d.state !== "cancelled").length);
  for (const profile of ORDER) {
    const listed = libraryDownloadsOf(owned, owners, profile);
    assert.ok(listed.length > 0 && listed.every((d) => ownedOnlyBy(d, profile)), profile);
    assert.equal(libraryDownloadsOf(owned, owners, profile), listed);
  }
});

test("the merged history holds every profile's visits newest first, one profile is its own list, and a new store history merges again", () => {
  const s = { profiles: PROFILES, profileOrder: ORDER };
  const owners = sharedProfileOwners(s);
  assert.equal(sharedProfileOwners({ ...s }), owners, "same profiles, same map");
  assert.notEqual(sharedProfileOwners({ profiles: { ...PROFILES }, profileOrder: ORDER }), owners, "edited profiles, new map");
  const history = Object.fromEntries(ENGINES.map((engine, n) => [engine, { list: Array.from({ length: 50 }, (_, i) => visit(`https://${engine || "p"}.example/${i}`, `t${i}`, 10_000 - i * 3 - n)), floor: -Infinity, ready: true }]));
  const all = scopedHistory(owners, history, null, s);
  assert.equal(all.length, 150);
  assert.ok(all.every((v, i) => i === 0 || all[i - 1].lastVisit >= v.lastVisit), "newest first");
  assert.equal(scopedHistory(owners, history, null, s), all);
  assert.equal(scopedHistory(owners, history, "work", s), history.work.list, "one profile is its own list");
  assert.notEqual(scopedHistory(owners, { ...history }, null, s), all, "a new store history merges again");
});

test("indexed search narrows per keystroke like a full search, profile names included, and keeps the list when nothing drops out", () => {
  const owners = profileOwners({ profiles: PROFILES, profileOrder: ORDER });
  const history = mergedHistory(ENGINES.map((engine, n) => ({ list: Array.from({ length: 700 }, (_, i) => visit(`https://site${i % 13}.example/${engine}/${i}`, `Page ${i} topic ${i % 9}`, 900_000 - i * 10 - n)), owners: owners.get(engine) })));
  const extra = profileSearchOf(PROFILES);
  assert.equal(profileSearchOf(PROFILES), extra, "the profile search is shared per profiles");
  let memo = refinedSearch(null, history, "", extra);
  for (const q of ["w", "wo", "work", "work p", "work page", "work page 1", "work page 12", "studio topic 3"]) {
    memo = refinedSearch(memo, history, q, extra);
    assert.deepEqual(memo.result, searchItems(history, q, extra), q);
  }
  const broad = refinedSearch(null, history, "pag", extra);
  assert.equal(refinedSearch(broad, history, "page", extra).result, broad.result, "a letter that drops nothing keeps the same list");
  assert.equal(refinedSearch(null, history, "e", extra).result, history, "a query everything matches is the source itself");
});

test("priming builds the search index in slices that a search then finishes", async () => {
  const history = Array.from({ length: 3000 }, (_, i) => visit(`https://p.example/${i}`, `Entry ${i}`, 50_000 - i));
  const stop = primeSearchText(history, 0, 0);
  await new Promise((r) => setTimeout(r, 5));
  stop();
  assert.deepEqual(refinedSearch(null, history, "entry 29").result, searchItems(history, "entry 29"), "a half-built index still finds everything");
});

test("a list row is reused when its slot shows the same items", () => {
  const a = { id: 1 }, b = { id: 2 };
  assert.ok(sameDaySlot({ kind: "row", items: [a, b] }, { kind: "row", items: [a, b] }));
  assert.ok(!sameDaySlot({ kind: "row", items: [a] }, { kind: "row", items: [b] }));
  assert.ok(!sameDaySlot({ kind: "row", items: [a, b] }, { kind: "row", items: [a] }));
  assert.ok(sameDaySlot({ kind: "header", title: "Today" }, { kind: "header", title: "Today" }));
  assert.ok(!sameDaySlot({ kind: "header", title: "Today" }, { kind: "row", items: [a] }));
});

test("a download row finds its record by id in a long list", () => {
  assert.equal(downloadById(DOWNLOADS, "d599"), DOWNLOADS[599]);
  assert.equal(downloadById(DOWNLOADS, "missing"), undefined);
  assert.equal(downloadById(DOWNLOADS.slice(0, 3), "d1"), DOWNLOADS[1]);
});

test("a window's downloads are filtered once per store list and kept until its profile changes", () => {
  const { downloadsIn } = downloadsSlice;
  const windows = { w: { kind: "normal", profileId: "work" } };
  const s = { downloads: DOWNLOADS, windows, profiles: { ...PROFILES, work: { ...PROFILES.work } } };
  const list = downloadsIn(s, "w");
  assert.deepEqual(list.map((d) => d.id), DOWNLOADS.filter((d) => d.profile === "work").map((d) => d.id));
  assert.equal(downloadsIn({ ...s, windows: { w: { ...windows.w } } }, "w"), list, "an edited window in the same profile keeps the list");
  assert.notEqual(downloadsIn({ ...s, windows: { w: { kind: "normal", profileId: "studio" } } }, "w"), list);
  assert.notEqual(downloadsIn({ ...s, downloads: [...DOWNLOADS] }, "w"), list, "a new store list filters again");
});

test("Media drops what lived in a download folder that is gone, so the missing folder shows instead of dead tiles", async () => {
  const { withoutMissingFolders, mediaFolderProblem } = await import("./hooks.ts");
  const item = (path) => ({ id: path, download: { path } });
  const items = [item("/gone/Downloads/a.jpg"), item("/gone/Downloads/b.mp4"), item("/gone/Downloads-old/c.png")];
  const missing = [{ folder: "/gone/Downloads", status: "missing" }];
  assert.deepEqual(withoutMissingFolders(items, missing).map((m) => m.id), ["/gone/Downloads-old/c.png"]);
  assert.equal(mediaFolderProblem(missing), "missing");
  const readable = [{ folder: "/gone/Downloads", status: "ok" }];
  assert.equal(withoutMissingFolders(items, readable), items, "a readable folder keeps the list as it is");
  assert.equal(withoutMissingFolders(items, [{ folder: "/gone/Downloads", status: "denied" }]), items, "a refused folder's files may still be there");
});
