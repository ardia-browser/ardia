import { create } from "zustand";
import { beginInteraction, INTERACTION_WINDOW_MS } from "../app/interactionPerf";
import { history } from "../history/store";
import { currentPreferences } from "../settings/store";
import { currentTabs, useTabs } from "../tabs/store";
import { idleMacTabs, macTabIndex, mergeSyncedHistory, syncedBookmarks } from "../sync/spaces";
import { selectedProfile, syncData } from "../sync/store";
import { idleRows, remoteSuggestions, setSearchEngine, setSources, setSyncedSearch, suggest, type SuggestContext, type TrayRow } from "./omnibox";
import { withPasteRow, type PasteOffer } from "./pasteRow";
import { copy } from "../../lib/platformCopy";
import { clipboardOffer } from "../../platform/system";
import { settled } from "../pages/store";
import { buildSources, recentSearches, sourcesKey } from "./sources";
import { spaceTabs } from "../tabs/tabsState";

export type SearchOrigin = "home" | "start" | "page";

export type SearchEnding = "submitted" | "cancelled";

export type TrayArrival = "rises" | "atRest";

type SearchState = {
  open: boolean;
  ending: SearchEnding;
  origin: SearchOrigin;
  initialText: string;
  text: string;
  rows: TrayRow[];
  completion: string;
  completedFor: string;
  session: number;
  fieldVersion: number;
  incognitoOnCancel: boolean | null;
  arrival: TrayArrival;
};

export const useSearch = create<SearchState>()(() => ({
  open: false,
  ending: "cancelled",
  origin: "home",
  initialText: "",
  text: "",
  rows: [],
  completion: "",
  completedFor: "",
  session: 0,
  fieldVersion: 0,
  incognitoOnCancel: null,
  arrival: "rises",
}));

let remote: { text: string; values: string[] } = { text: "", values: [] };
let inFlight: AbortController | null = null;
let fedSources = "";
let context: SuggestContext = { currentUrl: null, currentTabId: null };
let paste: PasteOffer | null = null;

export function feedSources() {
  const key = `${sourcesKey(useTabs.getState().listing, history().revision(), syncData().revision)}:${useTabs.getState().spaces.current}`;
  if (key === fedSources) return;
  fedSources = key;
  const profile = selectedProfile();
  const local = history().summary();
  setSources(buildSources(spaceTabs(currentTabs()), profile ? mergeSyncedHistory(local, profile.history) : local, profile ? syncedBookmarks(profile) : []));
  const shown = useSearch.getState();
  if (shown.open && !shown.text.trim()) useSearch.setState({ rows: rowsFor(shown.text, []) });
}

function suggestionsFor(text: string, remoteValues: readonly string[]): { rows: TrayRow[]; completion: string } {
  if (!text.trim()) return { rows: rowsFor(text, remoteValues), completion: "" };
  return suggest(text, remoteValues, context, macTabIndex(selectedProfile(), syncData().view.devices));
}

function rowsFor(text: string, remoteValues: readonly string[]): TrayRow[] {
  const profile = selectedProfile();
  if (text.trim()) return suggest(text, remoteValues, context, macTabIndex(profile, syncData().view.devices)).rows;
  const idle = useTabs.getState().incognito ? [] : idleRows(recentSearches(history().summary()), idleMacTabs(profile, syncData().view.devices));
  return withPasteRow(idle, text, paste);
}

function offerPaste(session: number) {
  paste = null;
  if (!copy().offersPasteAndGo) return;
  void settled(() => clipboardOffer(), null).then((offer) => {
    const state = useSearch.getState();
    if (!offer || !state.open || state.session !== session) return;
    paste = offer;
    if (!state.text.trim()) useSearch.setState({ rows: rowsFor(state.text, []) });
  });
}

export const refreshSearchRows = () => useSearch.setState((state) => ({ rows: rowsFor(state.text, []) }));

export function applySearchEngine() {
  const { status, view } = syncData();
  if (status.isEnabled && view.search) setSyncedSearch(view.search);
  else setSearchEngine(currentPreferences().searchEngineId);
}

export function presentSearch(origin: SearchOrigin, text = "", incognitoOnCancel: boolean | null = null, page: SuggestContext | null = null, arrival: TrayArrival = "rises") {
  beginInteraction("tray open", INTERACTION_WINDOW_MS.trayOpen);
  inFlight?.abort();
  remote = { text: "", values: [] };
  context = page ?? { currentUrl: null, currentTabId: null };
  feedSources();
  useSearch.setState((state) => ({
    open: true,
    ending: "cancelled",
    origin,
    initialText: text,
    text,
    rows: rowsFor(text, []),
    completion: "",
    completedFor: "",
    session: state.session + 1,
    fieldVersion: 0,
    incognitoOnCancel,
    arrival,
  }));
  offerPaste(useSearch.getState().session);
}

export function dismissSearch(ending: SearchEnding = "cancelled") {
  inFlight?.abort();
  useSearch.setState({ open: false, ending, incognitoOnCancel: null });
}

const REMOTE_DELAY_MS = 150;

let typed: string | null = null;
let frame: ReturnType<typeof requestAnimationFrame> | null = null;
let remoteTimer: ReturnType<typeof setTimeout> | null = null;

function showRows(text: string) {
  const carried = remote.text && text.startsWith(remote.text) ? remote.values : [];
  const suggested = suggestionsFor(text, carried);
  useSearch.setState({ text, rows: suggested.rows, completion: suggested.completion, completedFor: text });
  inFlight?.abort();
  if (remoteTimer) clearTimeout(remoteTimer);
  if (!text.trim() || !currentPreferences().searchSuggestions) return;
  remoteTimer = setTimeout(() => {
    remoteTimer = null;
    const controller = new AbortController();
    inFlight = controller;
    void remoteSuggestions(text, controller.signal).then((outcome) => {
      if (controller.signal.aborted || useSearch.getState().text !== text) return;
      remote = { text, values: outcome.values };
      const merged = suggestionsFor(text, outcome.values);
      useSearch.setState({ rows: merged.rows, completion: merged.completion, completedFor: text });
    });
  }, REMOTE_DELAY_MS);
}

export function typeSearch(text: string) {
  typed = text;
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const next = typed;
    typed = null;
    if (next !== null) showRows(next);
  });
}

export function setSearchText(text: string) {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  typed = null;
  useSearch.setState((state) => ({ fieldVersion: state.fieldVersion + 1 }));
  showRows(text);
}

export const searchState = () => useSearch.getState();
