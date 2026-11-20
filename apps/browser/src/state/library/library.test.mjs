import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { useLibrary, markLibraryOpen, libraryAvailable, showLibrarySection } = await import("./library.ts");
const { openLibrary, closeLibrary, toggleLibrary, setLibraryQuery, setLibraryFilter, pickLibraryItem } = await import("./actions.ts");
const { setLibraryPagerDriver } = await import("./pagerBridge.ts");
const { takeDownloadsPanelCounts } = await import("../telemetry/downloadsPanelCounts.ts");
const { escapePressed, startUnclaimedEscape } = await import("../windows/unclaimedEscape.ts");
const { emitAppEvent } = await import("../../test-native/shell.ts");
const { setPopover, popoverOf } = await import("../tabs/pageState.ts");
startUnclaimedEscape();

const S = () => useBrowser.getState();
const L = (w) => useLibrary.getState().windows[w];
const isOpen = (w) => !!L(w)?.open;
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const WORK = { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 };
const download = (id, extra = {}) => ({
  id, url: `https://dl.example/${id}`, filename: id, path: `/tmp/${id}`, state: "downloading", paused: false, received: 0, total: 1, speed: 0, mimeType: "", profile: "", ...extra,
});

let driverCalls = [];
function withoutPager() {
  driverCalls = [];
  setLibraryPagerDriver((windowId, open) => {
    driverCalls.push([windowId, open]);
    return false;
  });
}

function twoWindows({ library = true } = {}) {
  S().hydrate({ profiles: { default: PERSONAL, work: WORK }, profileOrder: ["default", "work"] });
  S().updateSettings({ sidebarLibrary: library, tabLayout: "sidebar", autoHideTabs: false });
  const a = S().createWindow({ url: "https://a.example/" });
  const b = S().createWindow({ url: "https://b.example/" });
  S().setFocusedWindow(a);
  for (const w of Object.keys(useLibrary.getState().windows)) markLibraryOpen(w, false, "layout");
  withoutPager();
  return { a, b };
}

test("each window opens, closes and remembers its own section, query and filter", () => {
  const { a, b } = twoWindows();
  openLibrary(a, "button", "history");
  assert.equal(isOpen(a), true);
  assert.equal(isOpen(b), false, "opening one window's Library leaves the other closed");
  setLibraryQuery(a, "recipes");
  openLibrary(b, "command", "media");
  setLibraryFilter(b, "video");
  assert.equal(L(a).section, "history");
  assert.equal(L(a).query, "recipes");
  assert.equal(L(b).section, "media");
  assert.equal(L(b).filter, "video");
  assert.equal(L(b).query, "", "a query typed in one window doesn't reach another");
  closeLibrary(a, "escape");
  assert.equal(isOpen(a), false);
  assert.equal(isOpen(b), true, "closing one window's Library leaves the other open");
  showLibrarySection(b, "profiles");
  assert.equal(L(b).section, "profiles");
  assert.equal(L(a).section, "history", "a section change in one window doesn't move another");
});

test("toggle opens a closed Library and closes an open one", () => {
  const { a } = twoWindows();
  toggleLibrary(a, "command");
  assert.equal(isOpen(a), true);
  toggleLibrary(a, "command");
  assert.equal(isOpen(a), false);
  toggleLibrary(a, "button");
  assert.equal(isOpen(a), true);
});

test("a private window has no pager, so the Library opens and closes on state alone", () => {
  twoWindows();
  const p = S().createWindow({ kind: "private", url: "https://p.example/" });
  withoutPager();
  openLibrary(p, "button", "downloads");
  assert.deepEqual(driverCalls, [[p, true]]);
  assert.equal(isOpen(p), true, "the driver said no pager, so the state opens it for the reveal spring");
  closeLibrary(p, "back");
  assert.equal(isOpen(p), false);
});

test("turning the setting off closes every open Library", () => {
  const { a, b } = twoWindows();
  openLibrary(a, "button");
  openLibrary(b, "command");
  S().updateSettings({ sidebarLibrary: false });
  assert.equal(isOpen(a), false);
  assert.equal(isOpen(b), false);
  openLibrary(a, "command");
  assert.equal(isOpen(a), false, "with the setting off the command does nothing");
});

test("a layout with no docked sidebar closes the Library and keeps it closed", () => {
  const { a } = twoWindows();
  openLibrary(a, "button");
  S().updateSettings({ autoHideTabs: true });
  assert.equal(isOpen(a), false, "hiding the sidebar closes it");
  openLibrary(a, "command");
  assert.equal(isOpen(a), false, "the command does nothing while the sidebar is hidden");
  assert.deepEqual(driverCalls.filter(([, open]) => open).length, 1, "the pager is not asked to reveal a page that isn't there");
  S().updateSettings({ autoHideTabs: false });
  openLibrary(a, "button");
  assert.equal(isOpen(a), true);
  S().updateSettings({ tabLayout: "top" });
  assert.equal(isOpen(a), false, "switching to top tabs closes it");
});

test("Little Ardia never opens the Library", () => {
  twoWindows();
  const little = S().createWindow({ kind: "small", url: "https://link.example/" });
  openLibrary(little, "command");
  toggleLibrary(little, "button");
  assert.equal(isOpen(little), false);
});

test("picking a profile switches the window to it and closes the Library", () => {
  const { a, b } = twoWindows();
  openLibrary(a, "button", "profiles");
  openLibrary(b, "button", "profiles");
  pickLibraryItem(a, "profiles", "work");
  assert.equal(S().windows[a].profileId, "work");
  assert.equal(isOpen(a), false);
  assert.equal(S().windows[b].profileId, "default", "the other window keeps its profile");
  assert.equal(isOpen(b), true);
});

test("a History visit opens in the window's profile when that profile owns it, otherwise in its owner's", () => {
  const { a } = twoWindows();
  const shownUrl = () => {
    const w = S().windows[a];
    return S().tabs[w.activeTabIds[w.profileId]]?.url;
  };
  openLibrary(a, "button", "history");
  pickLibraryItem(a, "history", "https://shared.example/", {}, "default");
  assert.deepEqual([S().windows[a].profileId, shownUrl()], ["default", "https://shared.example/"]);
  pickLibraryItem(a, "history", "https://work.example/", {}, "work");
  assert.deepEqual([S().windows[a].profileId, shownUrl()], ["work", "https://work.example/"]);
});

test("the Library is never saved with the session", async () => {
  const stub = await import("../../test-native/index.ts");
  const { flushPersistence, startPersistence } = await import("../session/persist.ts");
  stub.docs.clear();
  const stopSaving = startPersistence();
  const { a } = twoWindows();
  openLibrary(a, "button", "history");
  setLibraryQuery(a, "kept nowhere");
  flushPersistence();
  stopSaving();
  const saved = [...stub.docs.values()].join("\n");
  assert.ok(saved.includes("https://a.example/"), "the session with the window was written");
  assert.ok(!saved.includes("kept nowhere"), "the Library query is not on disk");
  assert.ok(!/"library/i.test(saved), "no Library state is on disk");
});

test("while the Library shows Downloads or Media no download pops the Downloads panel, and one Media can't show turns the Library to Downloads", () => {
  const { a } = twoWindows();
  const panelOpen = () => !!S().windowUi[a]?.downloadsOpen;
  takeDownloadsPanelCounts();
  for (const section of ["downloads", "media", "profiles", "history"]) {
    S().setDownloadsOpen(a, false);
    openLibrary(a, "button", section);
    S().upsertDownload(download(`new-in-${section}`));
    const shows = section === "downloads" || section === "media";
    assert.equal(panelOpen(), !shows, `${section}: the panel ${shows ? "stays shut" : "opens over the Library"}`);
  }
  assert.equal(takeDownloadsPanelCounts().downloads_panel_library_shown, 2);
  S().setDownloadsOpen(a, false);
  showLibrarySection(a, "media");
  S().upsertDownload(download("photo.jpg", { state: "finished", mimeType: "image/jpeg" }));
  assert.equal(L(a).section, "media", "a finished photo shows in Media, so Media stays");
  S().upsertDownload(download("running.mov"));
  assert.equal(panelOpen(), false);
  assert.equal(L(a).section, "downloads", "a download Media can't list yet turns the Library to Downloads, where it shows");
  showLibrarySection(a, "media");
  S().upsertDownload(download("notes.pdf", { state: "finished" }));
  assert.equal(L(a).section, "downloads", "so does a finished file that isn't media");
  showLibrarySection(a, "media");
  S().upsertDownload(download("risky", { dangerous: true }));
  assert.equal(panelOpen(), false, "the held download shows in the Library, not over it");
  assert.equal(L(a).section, "downloads");
  closeLibrary(a, "back");
  S().upsertDownload(download("after"));
  assert.equal(panelOpen(), true, "with the Library closed the panel opens as usual");
});

test("Escape closes the Library from the page, from the window, and only after a page popover closes", () => {
  const { a } = twoWindows();
  const tab = S().windows[a].tabIds[0];
  for (const [how, press] of [
    ["page", () => escapePressed(tab, "page")],
    ["window", () => emitAppEvent({ type: "unclaimedEscape", windowId: a })],
  ]) {
    openLibrary(a, "button");
    press();
    assert.equal(isOpen(a), false, how);
  }
  openLibrary(a, "button");
  setPopover(tab, "zoom");
  escapePressed(tab, "page");
  assert.equal(isOpen(a), true, "the popover takes the first Escape");
  assert.equal(popoverOf(tab), null);
  escapePressed(tab, "page");
  assert.equal(isOpen(a), false);
});

test("availability: a docked sidebar only", () => {
  const { a } = twoWindows();
  const p = S().createWindow({ kind: "private", url: "https://p.example/" });
  const little = S().createWindow({ kind: "small", url: "https://l.example/" });
  const row = (patch) => {
    S().updateSettings({ sidebarLibrary: true, tabLayout: "sidebar", autoHideTabs: false, ...patch });
    return [libraryAvailable(S(), a), libraryAvailable(S(), p), libraryAvailable(S(), little)];
  };
  assert.deepEqual(row({}), [true, true, false], "docked: main and private yes, Little Ardia no");
  assert.deepEqual(row({ sidebarLibrary: false }), [false, false, false], "setting off");
  assert.deepEqual(row({ autoHideTabs: true }), [false, false, false], "sidebar hidden");
  assert.deepEqual(row({ tabLayout: "top" }), [false, false, false], "top tabs");
  assert.equal(libraryAvailable(S(), "no-such-window"), false);
});
