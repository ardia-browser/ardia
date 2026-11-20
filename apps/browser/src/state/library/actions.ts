import { useBrowser, type BrowserState } from "../browser/store";
import { focus, openWindow, switchProfile } from "../browser/actions";
import { chooseFromMenu, type ChoiceItem } from "../app/menuChoice";
import { profileAccentOf } from "../profiles/looks";
import { openModeFor, openUrl } from "../bookmarks/actions";
import { openFile } from "../app/system";
import { usePages } from "../tabs/pageState";
import { consentToken } from "../telemetry/client";
import type { ConsentToken } from "../telemetry/choice";
import { markLibraryFilterChange, noteLibraryFolderPick, noteLibraryMediaFilter, noteLibraryOtherProfilePick, noteLibraryPick, noteLibraryProfileFilter, noteLibraryView } from "../telemetry/libraryCounts";
import { libraryMergesProfiles, listedProfiles } from "./profileScope";
import { folderItemPath } from "./items";
import { libraryViewOf, type LibraryListSection, type LibraryView } from "./views";
import { forgetLibrary, showLibrarySection, libraryAvailable, libraryOf, markLibraryOpen, patchLibrary, useLibrary, type LibraryEntry, type LibraryExit, type LibrarySection, type MediaKind } from "./library";
import { driveLibraryPager, libraryPagerIntent } from "./pagerBridge";
import { libraryShowableIn, pageFullscreenIn } from "./showable";

export type PickModifiers = { metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; middle?: boolean };

const FORCED_EXITS: readonly LibraryExit[] = ["settingOff", "layout"];

export function openLibrary(windowId: string, entry: LibraryEntry, section?: LibrarySection): boolean {
  startLibraryWatch();
  if (!libraryShowableIn(windowId)) return false;
  const library = libraryOf(windowId);
  if (section && section !== library.section) showLibrarySection(windowId, section);
  if (libraryHeadingOpen(windowId)) return true;
  if (!driveLibraryPager(windowId, true, entry)) markLibraryOpen(windowId, true, entry);
  return true;
}

const libraryHeadingOpen = (windowId: string): boolean => libraryPagerIntent(windowId)?.open ?? libraryOf(windowId).open;

const closingCause = (windowId: string, fallback: LibraryExit): LibraryExit => {
  const heading = libraryPagerIntent(windowId);
  return heading && !heading.open ? (heading.cause) : fallback;
};

export function closeLibrary(windowId: string, exit: LibraryExit) {
  const forced = FORCED_EXITS.includes(exit);
  if (!libraryHeadingOpen(windowId)) return void (forced && markLibraryOpen(windowId, false, closingCause(windowId, exit)));
  const driven = driveLibraryPager(windowId, false, exit);
  if (!driven || forced) markLibraryOpen(windowId, false, exit);
}

export function toggleLibrary(windowId: string, entry: LibraryEntry) {
  if (libraryHeadingOpen(windowId)) closeLibrary(windowId, entry);
  else openLibrary(windowId, entry);
}

export function setLibraryQuery(windowId: string, query: string) {
  if (libraryOf(windowId).query !== query) patchLibrary(windowId, { query });
}

export function setLibraryView(section: LibraryListSection, view: LibraryView) {
  const s = useBrowser.getState();
  const views = s.settings.sidebarLibraryViews;
  if (libraryViewOf(views, section) === view) return;
  markLibraryFilterChange();
  s.updateSettings({ sidebarLibraryViews: { ...views, [section]: view } });
  noteLibraryView(section, view);
}

export function setLibraryFilter(windowId: string, kind: MediaKind) {
  const library = libraryOf(windowId);
  if ((library.filter ?? "all") === kind) return;
  markLibraryFilterChange();
  patchLibrary(windowId, { filter: kind === "all" ? null : kind });
  noteLibraryMediaFilter(kind);
}

export function setLibraryProfile(windowId: string, profileId: string | null, consent?: ConsentToken | null) {
  if (libraryOf(windowId).profile === profileId) return;
  markLibraryFilterChange();
  patchLibrary(windowId, { profile: profileId });
  noteLibraryProfileFilter(profileId === null ? "all" : "one", consent);
}

const ALL_PROFILES_TITLE = "All Profiles";

export async function chooseLibraryProfile(windowId: string) {
  const consent = consentToken();
  const s = useBrowser.getState();
  if (!libraryMergesProfiles(s, windowId)) return;
  const chosen = libraryOf(windowId).profile;
  const items: ChoiceItem<{ profile: string | null }, never>[] = [
    { value: { profile: null }, title: ALL_PROFILES_TITLE, checked: chosen === null },
    { separator: true },
    ...listedProfiles(s).map((id) => ({ value: { profile: id }, title: s.profiles[id]!.name, checked: chosen === id, swatch: profileAccentOf(s.profiles[id]) })),
  ];
  const picked = await chooseFromMenu(items);
  if (picked && typeof picked === "object") setLibraryProfile(windowId, picked.profile, consent);
}

export function openVisitInProfile(windowId: string, url: string, profileId: string, modifiers: PickModifiers = {}) {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (!w || w.kind === "private" || !s.profiles[profileId]) return;
  noteLibraryOtherProfilePick("history");
  const mode = openModeFor(modifiers);
  if (mode === "window") return focus(openWindow({ url, profileId }));
  if (mode === "background") return void s.newTab(windowId, { url, profileId, background: true });
  s.switchProfile(windowId, profileId);
  useBrowser.getState().newTab(windowId, { url, profileId });
}

export function pickLibraryItem(windowId: string, section: LibrarySection, id: string, modifiers: PickModifiers = {}, owner?: string) {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (!w) return;
  noteLibraryPick(section);
  if (owner !== undefined && owner !== w.profileId && section !== "history" && section !== "profiles" && w.kind !== "private") noteLibraryOtherProfilePick(section);
  if (section === "history") {
    if (owner !== undefined && owner !== w.profileId && w.kind !== "private") return openVisitInProfile(windowId, id, owner, modifiers);
    const mode = openModeFor(modifiers);
    return openUrl(id, windowId, mode === "current" ? "foreground" : mode);
  }
  if (section === "profiles") {
    if (w.kind === "private" || !s.profiles[id]) return;
    if (id === w.profileId) return closeLibrary(windowId, "pick");
    markLibraryOpen(windowId, false, "pick");
    return switchProfile(windowId, id, true);
  }
  const folderPath = folderItemPath(id);
  if (folderPath !== null) {
    noteLibraryFolderPick();
    return void openFile(folderPath);
  }
  const download = s.downloads.find((d) => d.id === id);
  if (download?.state === "finished") void openFile(download.path);
}

function closeWhereUnavailable(s: BrowserState) {
  for (const [windowId, library] of Object.entries(useLibrary.getState().windows)) {
    if (!s.windows[windowId]) {
      forgetLibrary(windowId, undefined, closingCause(windowId, "windowClosed"));
      continue;
    }
    if (!(libraryPagerIntent(windowId)?.open ?? library.open) || (libraryAvailable(s, windowId) && !pageFullscreenIn(s, windowId))) continue;
    closeLibrary(windowId, s.settings.sidebarLibrary ? "layout" : "settingOff");
  }
}

const anyLibraryKnown = () => Object.keys(useLibrary.getState().windows).length > 0;

let watching = false;

export function startLibraryWatch() {
  if (watching) return;
  watching = true;
  useBrowser.subscribe((s, prev) => {
    if (!anyLibraryKnown() || (s.windows === prev.windows && s.settings === prev.settings)) return;
    closeWhereUnavailable(s);
  });
  usePages.subscribe((p, prev) => {
    if (p.pages !== prev.pages && anyLibraryKnown()) closeWhereUnavailable(useBrowser.getState());
  });
}
