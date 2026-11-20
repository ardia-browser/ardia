import { create } from "zustand";
import type { BrowserState } from "../browser/store";
import { tabLayoutOf, tabsShownIn } from "../browser/model";
import type { ConsentToken } from "../telemetry/choice";
import { noteLibraryClose, noteLibraryOpen, noteLibrarySectionView } from "../telemetry/libraryCounts";

export type LibrarySection = "media" | "downloads" | "profiles" | "history";
export type MediaKind = "all" | "image" | "video" | "audio";
export type LibraryEntry = "button" | "swipe" | "command";
export type LibraryExit = "back" | "escape" | "swipe" | "command" | "button" | "pick" | "settingOff" | "layout" | "quit" | "windowClosed";

export type LibraryWindow = { open: boolean; section: LibrarySection; query: string; filter: MediaKind | null; profile: string | null };

export const LIBRARY_SECTIONS: readonly LibrarySection[] = ["media", "downloads", "profiles", "history"];
export const MEDIA_KINDS: readonly MediaKind[] = ["all", "image", "video", "audio"];
export const DEFAULT_LIBRARY_SECTION: LibrarySection = "media";

export const CLOSED_LIBRARY: LibraryWindow = { open: false, section: DEFAULT_LIBRARY_SECTION, query: "", filter: null, profile: null };

const ENTRIES: readonly string[] = ["button", "swipe", "command"] satisfies LibraryEntry[];
const isLibraryEntry = (cause: LibraryEntry | LibraryExit): cause is LibraryEntry => ENTRIES.includes(cause);

export const useLibrary = create<{ windows: Record<string, LibraryWindow> }>()(() => ({ windows: {} }));

export const libraryOf = (windowId: string): LibraryWindow => useLibrary.getState().windows[windowId] ?? CLOSED_LIBRARY;

export const libraryOpenIn = (windowId: string | undefined): boolean => !!windowId && libraryOf(windowId).open;

export const libraryShows = (windowId: string | undefined, sections: readonly LibrarySection[]): boolean =>
  !!windowId && libraryOf(windowId).open && sections.includes(libraryOf(windowId).section);

export const mediaKindOf = (library: Pick<LibraryWindow, "filter">): MediaKind => library.filter ?? "all";

export function librarySectionsFor(kind: BrowserState["windows"][string]["kind"] | undefined): readonly LibrarySection[] {
  return kind === "private" ? LIBRARY_SECTIONS.filter((section) => section !== "profiles") : LIBRARY_SECTIONS;
}

export function libraryAvailable(s: BrowserState, windowId: string): boolean {
  const w = s.windows[windowId];
  return !!w && s.settings.sidebarLibrary && w.kind !== "small" && tabLayoutOf(s, windowId) === "sidebar" && tabsShownIn(s, windowId);
}

export function patchLibrary(windowId: string, patch: Partial<LibraryWindow>) {
  useLibrary.setState((s) => ({ windows: { ...s.windows, [windowId]: { ...(s.windows[windowId] ?? CLOSED_LIBRARY), ...patch } } }));
}

export function forgetLibrary(windowId: string, consent?: ConsentToken | null, exit: LibraryExit = "windowClosed") {
  const library = useLibrary.getState().windows[windowId];
  if (!library) return;
  if (library.open) noteLibraryClose(exit, consent);
  useLibrary.setState((s) => {
    const { [windowId]: _gone, ...rest } = s.windows;
    return { windows: rest };
  });
}

export function markLibraryOpen(windowId: string, open: boolean, cause: LibraryEntry | LibraryExit, consent?: ConsentToken | null) {
  const library = libraryOf(windowId);
  if (library.open === open) return;
  patchLibrary(windowId, { open });
  if (!open) return noteLibraryClose(cause, consent);
  if (isLibraryEntry(cause)) noteLibraryOpen(cause, consent);
  noteLibrarySectionView(library.section, consent);
}

export function showLibrarySection(windowId: string, section: LibrarySection, consent?: ConsentToken | null) {
  const library = libraryOf(windowId);
  if (library.section === section) return;
  patchLibrary(windowId, { section, query: "" });
  if (library.open) noteLibrarySectionView(section, consent);
}
