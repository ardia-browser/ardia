import assert from "node:assert/strict";
import { test } from "node:test";

const scope = await import("./profileScope.ts");
const items = await import("./items.ts");
const { useBrowser } = await import("../browser/store.ts");
const { pickLibraryItem, setLibraryProfile } = await import("./actions.ts");
const { libraryOf } = await import("./library.ts");
const { takeLibraryCounts } = await import("../telemetry/libraryCounts.ts");

const { mergedHistory, historyOwnersOf, libraryMergesProfiles, libraryProfileFilterOf, profileOwners, downloadOwners, withinProfile, profileSearchOf, visitKeyOf, parseVisitKey, engineHistories, ownersOfEngines, soleOwner, actingOwner } = scope;
const { mediaItems, downloadItems, searchItems } = items;

const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const WORK = { id: "work", name: "Work", color: "blue", icon: "briefcase.fill", createdAt: 1 };
const STUDIO = { id: "studio", name: "Studio", color: "green", icon: null, createdAt: 2 };
const PROFILES = { default: PERSONAL, work: WORK, studio: STUDIO };
const ORDER = ["default", "work", "studio"];

const visit = (url, lastVisit, title = url) => ({ url, title, favicon: null, visits: 1, lastVisit });
const download = (id, extra = {}) => ({
  id, url: `https://dl.example/${id}`, filename: id, path: `/Users/me/Downloads/${id}`, state: "finished", paused: false, received: 1, total: 1, speed: 0, mimeType: "", profile: "", startTime: 1, ...extra,
});
const state = (settings = {}, windows = { w: { kind: "normal", profileId: "default" } }) => ({ profiles: PROFILES, profileOrder: ORDER, windows, settings: { sidebarLibraryAllProfiles: true, ...settings } });

test("the Library merges profiles only with the setting on, in a normal window, with more than one profile", () => {
  assert.equal(libraryMergesProfiles(state(), "w"), true);
  assert.equal(libraryMergesProfiles(state({ sidebarLibraryAllProfiles: false }), "w"), false, "off keeps today's current-profile Library");
  assert.equal(libraryMergesProfiles(state({}, { w: { kind: "private", profileId: "incognito:w@default" } }), "w"), false, "an Incognito window shows only its own");
  assert.equal(libraryMergesProfiles({ ...state(), profileOrder: ["default"] }, "w"), false, "one profile has nothing to merge");
  assert.equal(libraryMergesProfiles(state(), "gone"), false);
  assert.equal(libraryProfileFilterOf(state(), "w", "work"), "work");
  assert.equal(libraryProfileFilterOf(state(), "w", "deleted"), null, "a filter on a deleted profile falls back to all");
  assert.equal(libraryProfileFilterOf(state({ sidebarLibraryAllProfiles: false }), "w", "work"), null, "the filter only applies while merging");
});

test("each engine profile maps to the profiles that use it, in sidebar order", () => {
  const owners = profileOwners({ profiles: { ...PROFILES, twin: { ...STUDIO, id: "twin", dataId: "studio" } }, profileOrder: [...ORDER, "twin"] });
  assert.deepEqual(owners.get(""), ["default"], "the default profile's engine is the empty name");
  assert.deepEqual(owners.get("work"), ["work"]);
  assert.deepEqual(owners.get("studio"), ["studio", "twin"]);
  assert.deepEqual(ownersOfEngines(owners, ["", "work"]), ["default", "work"]);
  assert.equal(soleOwner(["work"]), "work");
  assert.equal(soleOwner(["work", "studio"]), undefined);
});

test("History from every profile merges newest first and remembers whose each visit is", () => {
  const personal = [visit("https://a.example/", 50), visit("https://same.example/", 30), visit("https://c.example/", 10)];
  const work = [visit("https://same.example/", 40), visit("https://w.example/", 20)];
  const merged = mergedHistory([{ list: personal, owners: ["default"] }, { list: work, owners: ["work"] }, { list: [], owners: ["studio"] }]);
  assert.deepEqual(merged.map((v) => v.lastVisit), [50, 40, 30, 20, 10]);
  assert.deepEqual(merged.map((v) => historyOwnersOf(v)), [["default"], ["work"], ["default"], ["work"], ["default"]]);
  const keys = merged.map(visitKeyOf);
  assert.equal(new Set(keys).size, keys.length, "the same page in two profiles gets two keys");
  assert.deepEqual(parseVisitKey(keys[1]), { profileId: "work", url: "https://same.example/" });
  assert.deepEqual(parseVisitKey("https://plain.example/"), { profileId: null, url: "https://plain.example/" });
  assert.equal(mergedHistory([{ list: personal, owners: ["default"] }, { list: [], owners: ["work"] }]), personal, "one non-empty profile is passed through as is");

  const history = { "": { list: personal }, work: { list: work } };
  const owners = profileOwners({ profiles: PROFILES, profileOrder: ORDER });
  const onlyWork = engineHistories(owners, history, "work", { profiles: PROFILES });
  assert.equal(onlyWork.length, 1);
  assert.equal(onlyWork[0].list, work, "a filtered History reads the one profile's list without copying it");
  assert.equal(engineHistories(owners, history, null, { profiles: PROFILES }).length, 3);

  const twin = { ...PROFILES, twin: { ...WORK, id: "twin", name: "Twin", dataId: "work" } };
  const sharing = profileOwners({ profiles: twin, profileOrder: [...ORDER, "twin"] });
  for (const id of ["work", "twin"]) assert.deepEqual(engineHistories(sharing, history, id, { profiles: twin })[0].list, [], `${id} shares its history, so filtering to it alone shows none of it`);
  assert.equal(engineHistories(sharing, history, "default", { profiles: twin })[0].list, personal);
  const all = mergedHistory(engineHistories(sharing, history, null, { profiles: twin }));
  assert.deepEqual(historyOwnersOf(all.find((v) => work.includes(v))), ["work", "twin"], "All Profiles still lists it, under both");
});

test("downloads belong to their profile, and private downloads never join the merged list", () => {
  const owners = profileOwners({ profiles: PROFILES, profileOrder: ORDER });
  assert.deepEqual(downloadOwners(owners, { profile: "" }), ["default"]);
  assert.deepEqual(downloadOwners(owners, { profile: "work" }), ["work"]);
  assert.equal(downloadOwners(owners, { profile: "work", offTheRecord: true }), undefined);
  assert.equal(downloadOwners(owners, { profile: "incognito:w1@work" }), undefined);
  assert.equal(downloadOwners(owners, { profile: "removed" }), undefined);

  const rows = downloadItems([download("a.pdf"), download("b.pdf", { profile: "work" })], (d) => downloadOwners(owners, d));
  assert.deepEqual(rows.map((r) => r.owners), [["default"], ["work"]]);
  assert.deepEqual(withinProfile(rows, "work").map((r) => r.id), ["b.pdf"]);
  assert.equal(withinProfile(rows, null), rows);
  assert.equal(downloadItems([download("a.pdf")])[0].owners, undefined, "without merging, items carry no owners");
  const sharing = profileOwners({ profiles: { ...PROFILES, twin: { ...WORK, id: "twin", dataId: "work" } }, profileOrder: [...ORDER, "twin"] });
  const shared = downloadItems([download("a.pdf"), download("b.pdf", { profile: "work" })], (d) => downloadOwners(sharing, d));
  assert.deepEqual(withinProfile(shared, "work").map((r) => r.id), [], "a download from a profile whose data another profile shares shows only under All Profiles");
  assert.deepEqual(withinProfile(shared, "default").map((r) => r.id), ["a.pdf"]);
});

test("Media marks downloads with their profile and folder files with every profile that shares the folder", () => {
  const owners = profileOwners({ profiles: PROFILES, profileOrder: ORDER });
  const shared = { path: "/Users/me/Downloads/beach.jpg", name: "beach.jpg", kind: "image", size: 1, added: 5 };
  const own = { path: "/Users/me/Studio/sketch.png", name: "sketch.png", kind: "image", size: 1, added: 6 };
  const byPath = new Map([[shared.path, ["default", "work"]], [own.path, ["studio"]]]);
  const media = mediaItems([download("photo.png", { mimeType: "image/png", profile: "work", startTime: 7 })], "all", [shared, own], {
    download: (d) => downloadOwners(owners, d),
    file: (file) => byPath.get(file.path),
  });
  assert.deepEqual(media.map((m) => [m.download.filename, m.owners]), [["photo.png", ["work"]], ["sketch.png", ["studio"]], ["beach.jpg", ["default", "work"]]]);
  assert.deepEqual(withinProfile(media, "work").map((m) => m.download.filename), ["photo.png"], "a shared folder's files belong to no one profile, so they show only under All Profiles");
  assert.deepEqual(withinProfile(media, "default").map((m) => m.download.filename), []);
  assert.deepEqual(withinProfile(media, null).map((m) => m.download.filename), ["photo.png", "sketch.png", "beach.jpg"]);
  assert.deepEqual(withinProfile(media, "studio").map((m) => m.download.filename), ["sketch.png"]);
});

test("search also matches the profile's name, word by word", () => {
  const owners = profileOwners({ profiles: PROFILES, profileOrder: ORDER });
  const rows = downloadItems([download("report.pdf", { profile: "work" }), download("report-v2.pdf"), download("holiday.jpg", { profile: "work" })], (d) => downloadOwners(owners, d));
  const extra = profileSearchOf(PROFILES);
  assert.deepEqual(searchItems(rows, "work", extra).map((r) => r.id), ["report.pdf", "holiday.jpg"]);
  assert.deepEqual(searchItems(rows, "work report", extra).map((r) => r.id), ["report.pdf"], "one word can match the name and another the file");
  assert.deepEqual(searchItems(rows, "personal", extra).map((r) => r.id), ["report-v2.pdf"]);
  assert.deepEqual(searchItems(rows, "work").map((r) => r.id), [], "without merging, the profile name isn't searched");
  const merged = mergedHistory([{ list: [visit("https://x.example/", 2)], owners: ["studio"] }, { list: [visit("https://y.example/", 1)], owners: ["default"] }]);
  assert.deepEqual(searchItems(merged, "studio", extra).map((v) => v.url), ["https://x.example/"]);
});

const S = () => useBrowser.getState();

function twoProfileWindow() {
  S().hydrate({ profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"] });
  S().updateSettings({ sidebarLibrary: true, sidebarLibraryAllProfiles: true, tabLayout: "sidebar", autoHideTabs: false });
  const w = S().createWindow({ url: "https://a.example/" });
  S().setFocusedWindow(w);
  takeLibraryCounts();
  return w;
}

const bumped = (counts) => Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));

test("the profile filter is remembered per window and counted as all or one, never which", () => {
  const w = twoProfileWindow();
  setLibraryProfile(w, "work");
  assert.equal(libraryOf(w).profile, "work");
  setLibraryProfile(w, "work");
  setLibraryProfile(w, null);
  assert.equal(libraryOf(w).profile, null);
  assert.deepEqual(bumped(takeLibraryCounts()), { library_profile_filter_one: 1, library_profile_filter_all: 1 });
});

test("opening another profile's visit switches the window to that profile and opens it there", () => {
  const w = twoProfileWindow();
  const before = S().windows[w].tabIds.length;
  pickLibraryItem(w, "history", "https://work.example/", {}, "work");
  const win = S().windows[w];
  assert.equal(win.profileId, "work");
  const active = S().tabs[win.activeTabIds.work];
  assert.equal(active.profileId, "work");
  assert.equal(active.url || active.page.nav?.url, "https://work.example/", "the page opens in front, in the work profile");
  assert.ok(win.tabIds.length > before);
  const counts = bumped(takeLibraryCounts());
  assert.equal(counts.library_other_profile_picks_history, 1);
  assert.equal(counts.library_picks_history, 1);

  pickLibraryItem(w, "history", "https://personal.example/", { metaKey: true }, "default");
  assert.equal(S().windows[w].profileId, "work", "a background open leaves the window where it is");
  assert.ok(Object.values(S().tabs).some((t) => t.profileId === "default" && (t.url || t.page.nav?.url) === "https://personal.example/"), "it opens in the background in its own profile");

  takeLibraryCounts();
  pickLibraryItem(w, "history", "https://same.example/", {}, "work");
  assert.equal(bumped(takeLibraryCounts()).library_other_profile_picks_history, undefined, "the window's own profile isn't another profile");
});

test("a visit kept by profiles that share their data acts through the window's profile when it is one of them, else the first of them", () => {
  assert.equal(actingOwner(["work", "studio"], "default"), "work", "Remove reaches the shared history, not the window's own");
  assert.equal(actingOwner(["work", "studio"], "studio"), "studio", "the window's profile opens it in place");
  assert.equal(actingOwner(["work"], "default"), "work");
  assert.equal(actingOwner(undefined, "default"), undefined, "without the merge there is no owner to act through");
});
