import type { LibraryEntry, LibraryExit, LibrarySection, MediaKind } from "../library/library";
import { takeMorphCounts } from "../../platform/pager";
import type { FolderMediaStatus } from "../../platform/files";
import type { ConsentToken } from "./choice";
import { consentToken } from "./consentPeriod";
import { countFor } from "./countFor";
import { LIBRARY_LIST_SECTIONS, LIBRARY_VIEWS, type LibraryListSection, type LibraryView } from "../library/views";

const ENTRY_KEYS: Record<LibraryEntry, string> = {
  button: "library_opens_button",
  swipe: "library_opens_swipe",
  command: "library_opens_command",
};

const EXIT_KEYS: Record<LibraryExit, string> = {
  back: "library_closes_back",
  escape: "library_closes_escape",
  swipe: "library_closes_swipe",
  command: "library_closes_command",
  button: "library_closes_button",
  pick: "library_closes_pick",
  settingOff: "library_closes_setting_off",
  layout: "library_closes_layout",
  quit: "library_closes_quit",
  windowClosed: "library_closes_window_closed",
};

export type LibraryProfileEdit = "rename" | "color" | "icon" | "reorder" | "add" | "delete";

const PROFILE_EDITS: readonly LibraryProfileEdit[] = ["rename", "color", "icon", "reorder", "add", "delete"];
const SECTIONS: readonly LibrarySection[] = ["media", "downloads", "profiles", "history"];
const MEDIA_KINDS: readonly MediaKind[] = ["all", "image", "video", "audio"];
const FOLDER_STATUSES: readonly FolderMediaStatus[] = ["ok", "missing", "denied", "unavailable"];

const ZEROED = (): Record<string, number> => ({
  ...Object.fromEntries(Object.values(ENTRY_KEYS).map((key) => [key, 0])),
  ...Object.fromEntries(Object.values(EXIT_KEYS).map((key) => [key, 0])),
  ...Object.fromEntries(SECTIONS.map((section) => [`library_section_views_${section}`, 0])),
  ...Object.fromEntries(SECTIONS.map((section) => [`library_picks_${section}`, 0])),
  ...Object.fromEntries(MEDIA_KINDS.map((kind) => [`library_media_filter_${kind}`, 0])),
  ...Object.fromEntries(FOLDER_STATUSES.map((status) => [`library_media_folder_${status}`, 0])),
  ...Object.fromEntries(PROFILE_EDITS.map((edit) => [`library_profile_edits_${edit}`, 0])),
  ...Object.fromEntries(LIBRARY_LIST_SECTIONS.flatMap((section) => LIBRARY_VIEWS.map((view) => [`library_view_${section}_${view}`, 0]))),
  ...Object.fromEntries(LIBRARY_LIST_SECTIONS.map((section) => [`library_item_cards_${section}`, 0])),
  library_opens_refused: 0,
  library_profile_filter_all: 0,
  library_profile_filter_one: 0,
  library_other_profile_picks_media: 0,
  library_other_profile_picks_downloads: 0,
  library_other_profile_picks_history: 0,
  library_history_quick_removes_list: 0,
  library_history_quick_removes_cards: 0,
  library_item_card_swaps: 0,
  library_hover_previews: 0,
  library_hover_picks: 0,
  library_hover_drags: 0,
  library_footer_downloading: 0,
  library_footer_finished: 0,
  library_footer_blocked: 0,
  library_morph_frames: 0,
  library_morph_stalls: 0,
  library_media_folder_lists: 0,
  library_media_folder_items: 0,
  library_media_folder_picks: 0,
  library_searches: 0,
  library_switches: 0,
  library_switches_slow: 0,
  library_page_switches: 0,
  library_page_switches_slow: 0,
  library_list_slides: 0,
  library_searches_slow: 0,
  library_thumbnails: 0,
  library_thumbnails_slow: 0,
  library_thumbnails_failed: 0,
  library_thumbnails_sharpened: 0,
});

let counts = ZEROED();

function add(fields: Record<string, number>) {
  for (const [key, by] of Object.entries(fields)) counts[key] = (counts[key] ?? 0) + by;
}

const countAll = (consent: ConsentToken | null | undefined, fields: Record<string, number>) => countFor(consent, () => add(fields), fields);
const bump = (key: string, consent: ConsentToken | null | undefined) => countAll(consent, { [key]: 1 });

export const noteLibraryOpen = (entry: LibraryEntry, consent?: ConsentToken | null) => bump(ENTRY_KEYS[entry], consent);
export const noteLibraryOpenRefused = (consent?: ConsentToken | null) => bump("library_opens_refused", consent);
export const noteLibraryClose = (exit: LibraryExit, consent?: ConsentToken | null) => bump(EXIT_KEYS[exit], consent);
export const noteLibrarySectionView = (section: LibrarySection, consent?: ConsentToken | null) => bump(`library_section_views_${section}`, consent);
export const noteLibraryPick = (section: LibrarySection, consent?: ConsentToken | null) => bump(`library_picks_${section}`, consent);
export const noteLibraryMediaFilter = (kind: MediaKind, consent?: ConsentToken | null) => bump(`library_media_filter_${kind}`, consent);
export const noteLibraryProfileFilter = (choice: "all" | "one", consent?: ConsentToken | null) => bump(`library_profile_filter_${choice}`, consent);
export const noteLibraryOtherProfilePick = (section: LibraryListSection, consent?: ConsentToken | null) => bump(`library_other_profile_picks_${section}`, consent);
export const noteLibraryProfileEdit = (edit: LibraryProfileEdit, consent?: ConsentToken | null) => bump(`library_profile_edits_${edit}`, consent);
export const noteLibraryView = (section: LibraryListSection, view: LibraryView, consent?: ConsentToken | null) => bump(`library_view_${section}_${view}`, consent);
export const noteLibraryItemCard = (section: LibraryListSection, consent?: ConsentToken | null) => bump(`library_item_cards_${section}`, consent);
export const noteLibraryItemCardSwap = (consent?: ConsentToken | null) => bump("library_item_card_swaps", consent);
export const noteLibraryQuickRemove = (view: LibraryView, consent?: ConsentToken | null) => bump(`library_history_quick_removes_${view}`, consent);
export const noteLibraryHoverPreview = (consent?: ConsentToken | null) => bump("library_hover_previews", consent);
export const noteLibraryHoverPick = (consent?: ConsentToken | null) => bump("library_hover_picks", consent);
export const noteLibraryHoverDrag = (consent?: ConsentToken | null) => bump("library_hover_drags", consent);
export const noteLibraryFooterState = (state: "downloading" | "finished" | "blocked", consent?: ConsentToken | null) => bump(`library_footer_${state}`, consent);
export const noteLibraryFolderPick = (consent?: ConsentToken | null) => bump("library_media_folder_picks", consent);
const SLOW_SEARCH_MS = 50;

export const noteLibrarySearch = (ms: number, consent?: ConsentToken | null) => countAll(consent, { library_searches: 1, library_searches_slow: ms > SLOW_SEARCH_MS ? 1 : 0 });

const SLOW_SWITCH_MS = 100;

export const noteLibrarySwitch = (ms: number, consent?: ConsentToken | null) => countAll(consent, { library_switches: 1, library_switches_slow: ms > SLOW_SWITCH_MS ? 1 : 0 });

export type LibraryChangeMark = { at: number; consent: ConsentToken | null };

let filterChange: LibraryChangeMark | null = null;

export const markLibraryChange = (): LibraryChangeMark => ({ at: performance.now(), consent: consentToken() });

export const markLibraryFilterChange = () => void (filterChange = markLibraryChange());

export function claimLibraryFilterChange(): LibraryChangeMark | null {
  const mark = filterChange;
  filterChange = null;
  return mark;
}

const SLOW_PAGE_SWITCH_MS = 50;

export const noteLibraryPageSwitch = (ms: number, consent?: ConsentToken | null) =>
  countAll(consent, { library_page_switches: 1, library_page_switches_slow: ms > SLOW_PAGE_SWITCH_MS ? 1 : 0 });

export const noteLibraryListSlide = (consent?: ConsentToken | null) => bump("library_list_slides", consent);

const SLOW_THUMBNAIL_MS = 1000;

export const noteLibraryThumbnail = (ms: number, found: boolean, sharpened: boolean, consent?: ConsentToken | null) =>
  countAll(consent, {
    library_thumbnails: 1,
    library_thumbnails_slow: ms > SLOW_THUMBNAIL_MS ? 1 : 0,
    library_thumbnails_failed: found ? 0 : 1,
    library_thumbnails_sharpened: sharpened ? 1 : 0,
  });

export const noteLibraryFolderListing = (items: number, status: FolderMediaStatus, consent?: ConsentToken | null) =>
  countAll(consent, { library_media_folder_lists: 1, library_media_folder_items: items, [`library_media_folder_${status}`]: 1 });

export function takeLibraryCounts(): Record<string, number> {
  const taken = counts;
  counts = ZEROED();
  const native = takeMorphCounts();
  taken.library_morph_frames = (taken.library_morph_frames ?? 0) + native.frames;
  taken.library_morph_stalls = (taken.library_morph_stalls ?? 0) + native.late;
  return taken;
}
