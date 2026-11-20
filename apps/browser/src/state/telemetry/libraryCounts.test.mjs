import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { markLibraryOpen, showLibrarySection } = await import("../library/library.ts");
const { openLibrary, closeLibrary, toggleLibrary, setLibraryQuery, setLibraryFilter, pickLibraryItem } = await import("../library/actions.ts");
const { setLibraryPagerDriver } = await import("../library/pagerBridge.ts");
const { takeLibraryCounts, noteLibraryFolderListing } = await import("./libraryCounts.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const WORK = { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 };

function oneWindow(pager) {
  S().hydrate({ profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"] });
  S().updateSettings({ sidebarLibrary: true, tabLayout: "sidebar", autoHideTabs: false });
  const w = S().createWindow({ url: "https://a.example/" });
  S().setFocusedWindow(w);
  setLibraryPagerDriver((windowId, open, cause) => {
    if (!pager) return false;
    queueMicrotask(() => markLibraryOpen(windowId, open, cause));
    return true;
  });
  takeLibraryCounts();
  if (!sectionViewKeys.size) learnSectionViewKeys(w);
  return w;
}

const bumped = (counts) => Object.entries(counts).filter(([key, n]) => n > 0 && !sectionViewKeys.has(key));
const sectionViewKeys = new Set();
function learnSectionViewKeys(w) {
  openLibrary(w, "command");
  for (const section of ["downloads", "profiles", "history", "media"]) {
    takeLibraryCounts();
    showLibrarySection(w, section);
    for (const [key, n] of Object.entries(takeLibraryCounts())) if (n > 0) sectionViewKeys.add(key);
  }
  closeLibrary(w, "back");
  takeLibraryCounts();
}
function countsOf(run) {
  takeLibraryCounts();
  run();
  return bumped(takeLibraryCounts());
}

test("every way in and every way out lands in its own count, once, beside the section it shows", () => {
  const w = oneWindow(null);
  const keys = new Set();
  const closeVia = (exit) => {
    openLibrary(w, "button");
    takeLibraryCounts();
    closeLibrary(w, exit);
    const counts = bumped(takeLibraryCounts());
    assert.equal(counts.length, 1, `closing by ${exit} counts once: ${JSON.stringify(counts)}`);
    assert.equal(counts[0][1], 1);
    keys.add(counts[0][0]);
  };
  for (const exit of ["back", "escape", "swipe", "command", "button"]) closeVia(exit);
  assert.equal(keys.size, 5, "each exit has its own count");

  const entries = new Set();
  for (const entry of ["button", "command"]) {
    closeLibrary(w, "back");
    const counts = countsOf(() => openLibrary(w, entry));
    assert.equal(counts.length, 1, `opening by ${entry} counts once`);
    assert.equal(counts[0][1], 1);
    entries.add(counts[0][0]);
  }
  closeLibrary(w, "back");
  const swipe = countsOf(() => markLibraryOpen(w, true, "swipe"));
  assert.equal(swipe.length, 1, "a swipe onto the leading page counts as an entry");
  entries.add(swipe[0][0]);
  assert.equal(entries.size, 3, "each entry has its own count");
  for (const key of entries) assert.ok(!keys.has(key), "entries and exits don't share a count");

  const settingOff = countsOf(() => S().updateSettings({ sidebarLibrary: false }));
  assert.equal(settingOff.length, 1, "turning the setting off while open counts its exit");
  assert.ok(!keys.has(settingOff[0][0]));
  S().updateSettings({ sidebarLibrary: true });
  openLibrary(w, "button");
  const layout = countsOf(() => S().updateSettings({ autoHideTabs: true }));
  assert.equal(layout.length, 1, "hiding the sidebar while open counts its exit");
  assert.ok(!keys.has(layout[0][0]) && layout[0][0] !== settingOff[0][0]);
});

test("an open through the pager counts once, not again when the pager lands", async () => {
  const w = oneWindow({ cause: "button" });
  openLibrary(w, "button");
  await new Promise((r) => setTimeout(r, 0));
  const counts = bumped(takeLibraryCounts());
  assert.equal(counts.reduce((n, [, v]) => n + v, 0), 1, JSON.stringify(counts));
  toggleLibrary(w, "button");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bumped(takeLibraryCounts()).reduce((n, [, v]) => n + v, 0), 1, "and the close counts once");
});

test("closing a window with its Library open counts one window close, and a closed Library counts none", () => {
  const open = oneWindow(null);
  const shut = S().createWindow({ url: "https://b.example/" });
  openLibrary(open, "button");
  openLibrary(shut, "button");
  closeLibrary(shut, "back");
  takeLibraryCounts();
  S().closeWindow(open);
  S().closeWindow(shut);
  assert.deepEqual(bumped(takeLibraryCounts()), [["library_closes_window_closed", 1]]);
});

test("a pager-driven open and close count the cause that started them, not the pager's landing", async () => {
  const w = oneWindow({});
  const settle = () => new Promise((r) => setTimeout(r, 0));
  openLibrary(w, "command");
  await settle();
  assert.deepEqual(bumped(takeLibraryCounts()), [["library_opens_command", 1]]);
  closeLibrary(w, "escape");
  await settle();
  assert.deepEqual(bumped(takeLibraryCounts()), [["library_closes_escape", 1]]);
});

test("sections, filters and picks are counted per kind, and nothing typed reaches the counts", () => {
  const w = oneWindow(null);
  openLibrary(w, "button", "media");
  const sectionKeys = new Set();
  for (const section of ["downloads", "profiles", "history", "media"]) {
    takeLibraryCounts();
    showLibrarySection(w, section);
    const counts = Object.entries(takeLibraryCounts()).filter(([, n]) => n > 0);
    assert.equal(counts.length, 1, `viewing ${section} counts once`);
    sectionKeys.add(counts[0][0]);
  }
  assert.equal(sectionKeys.size, 4);
  const filterKeys = new Set();
  for (const kind of ["image", "video", "audio", "all"]) {
    const counts = countsOf(() => setLibraryFilter(w, kind));
    assert.equal(counts.length, 1, `the ${kind} filter counts once`);
    filterKeys.add(counts[0][0]);
  }
  assert.equal(filterKeys.size, 4);

  const secret = "private diagnosis clinic";
  const typed = countsOf(() => {
    setLibraryQuery(w, secret);
    setLibraryQuery(w, "https://secret.example/path");
  });
  const pick = countsOf(() => pickLibraryItem(w, "profiles", "work"));
  assert.ok(pick.length >= 1, "picking a profile counts");
  assert.equal(S().windows[w].profileId, "work");
  const all = takeLibraryCounts();
  for (const [key, value] of [...typed, ...pick, ...Object.entries(all)]) {
    assert.match(key, /^[a-z0-9_]+$/, `count names are fixed identifiers: ${key}`);
    assert.ok(Number.isInteger(value) && value >= 0, `${key} is a count`);
    assert.ok(!key.includes("secret") && !key.includes("diagnosis"));
  }
  assert.ok(Object.keys(all).length > 0, "the counts report every key, zero or not");
  assert.ok(Object.values(all).every((n) => n === 0), "taking the counts resets them");
});

test("a Media folder listing is counted with what came of it, never which folder", () => {
  takeLibraryCounts();
  noteLibraryFolderListing(12, "ok");
  noteLibraryFolderListing(0, "denied");
  const counts = takeLibraryCounts();
  assert.deepEqual(
    [counts.library_media_folder_lists, counts.library_media_folder_items, counts.library_media_folder_ok, counts.library_media_folder_denied, counts.library_media_folder_missing],
    [2, 12, 1, 1, 0],
  );
});
