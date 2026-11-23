import { create } from "zustand";
import { beginInteraction, INTERACTION_WINDOW_MS } from "../app/interactionPerf";
import { history } from "../history/store";
import { currentPreferences } from "../settings/store";
import { currentTabs, useTabs } from "../tabs/store";
import { idleMacTabs, macTabIndex, mergeSyncedHistory, syncedBookmarks } from "../sync/spaces";
import { selectedProfile, syncData } from "../sync/store";
import { idleRows, remoteSuggestions, searchEngineRevision, setSearchEngine, setSources, setSyncedSearch, suggest, withCurrentEngine, type SuggestContext, type TrayRow } from "./omnibox";
import { withPasteRow, type PasteOffer } from "./pasteRow";
import { clipboardOffer } from "../../platform/system";
import { settled } from "../pages/store";
import { buildSources, recentSearches, sourcesKey } from "./sources";
import { spaceTabs } from "../tabs/tabsState";
import { browseForMeOffered } from "../browseForMe/offer";
import { markSearchClosing, markSearchPhase, markSearchPressed } from "./searchTiming";
import { countUsage } from "../telemetry/telemetry";

export type SearchOrigin = "home" | "start" | "page";

export type SearchEnding = "submitted" | "cancelled";

export type TrayArrival = "rises" | "atRest" | "dockedMenu";

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
  editsPage: boolean;
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
  editsPage: false,
}));

let remote: { text: string; values: string[] } = { text: "", values: [] };
let inFlight: AbortController | null = null;
let fedSources = "";
let context: SuggestContext = { currentUrl: null, currentTabId: null };
let paste: PasteOffer | null = null;
let pasteReadIn: number | null = null;

const currentSourcesKey = () => `${sourcesKey(useTabs.getState().listing, history().revision(), syncData().revision)}:${useTabs.getState().spaces.current}`;

let clearsPagePrefill = false;
let refreshFallback: ReturnType<typeof setTimeout> | null = null;
let pendingRefresh: (() => void) | null = null;
let preparing: ReturnType<typeof setTimeout> | null = null;

export const setSearchClearsPagePrefill = (clears: boolean) => {
  clearsPagePrefill = clears;
};

const SEARCH_WARM_AFTER_LAUNCH_MS = 1500;
const REFRESH_WITHOUT_PRESENTATION_MS = 300;
const IDLE_SCOPES_KEPT = 8;

type IdleRows = { revision: string; engine: number; rows: TrayRow[] };
const idleMade = new Map<string, IdleRows>();

const idleScope = () => `${useTabs.getState().incognito}:${useTabs.getState().spaces.current}:${selectedProfile()?.syncId ?? ""}`;
const idleRevision = () => `${history().revision()}:${syncData().revision}:${searchEngineRevision()}`;
const idleIsCurrent = () => idleMade.get(idleScope())?.revision === idleRevision();

function idleRowsNow(): TrayRow[] {
  const scope = idleScope();
  const made = idleMade.get(scope);
  if (made && made.revision === idleRevision()) return made.rows;
  const rows = useTabs.getState().incognito ? [] : idleRows(recentSearches(history().summary()), idleMacTabs(selectedProfile(), syncData().view.devices));
  idleMade.delete(scope);
  idleMade.set(scope, { revision: idleRevision(), engine: searchEngineRevision(), rows });
  if (idleMade.size > IDLE_SCOPES_KEPT) idleMade.delete(idleMade.keys().next().value!);
  return rows;
}

function rowsAtPress(text: string): TrayRow[] {
  if (text.trim()) return rowsFor(text, []);
  const made = idleMade.get(idleScope());
  const rows = !made ? [] : made.engine === searchEngineRevision() ? made.rows : withCurrentEngine(made.rows);
  return withPasteRow(rows, text, paste);
}

export function searchPresented(session: number) {
  if (useSearch.getState().session !== session) return;
  const refresh = pendingRefresh;
  pendingRefresh = null;
  if (refreshFallback !== null) clearTimeout(refreshFallback);
  refreshFallback = null;
  refresh?.();
}

export function prepareSearch() {
  if (preparing !== null) return;
  preparing = setTimeout(() => {
    preparing = null;
    if (useSearch.getState().open) return;
    feedSources();
    idleRowsNow();
  }, 0);
}

export function warmSearchWhenIdle(): () => void {
  const warm = setTimeout(prepareSearch, SEARCH_WARM_AFTER_LAUNCH_MS);
  return () => clearTimeout(warm);
}

function refreshAfterOpening(session: number) {
  const sourcesStale = currentSourcesKey() !== fedSources;
  const idleStale = !idleIsCurrent();
  if (!sourcesStale && !idleStale) return;
  const pressed = useSearch.getState().rows;
  if (refreshFallback !== null) clearTimeout(refreshFallback);
  pendingRefresh = () => {
    const state = useSearch.getState();
    if (!state.open || state.session !== session) return;
    const shown = useSearch.getState();
    if (shown.rows !== pressed) {
      if (sourcesStale) feedSourcesQuietly();
      return;
    }
    if (sourcesStale) feedSourcesQuietly();
    if (shown.text.trim()) useSearch.setState({ rows: suggestionsFor(shown.text, remote.text && shown.text.startsWith(remote.text) ? remote.values : []).rows });
    else useSearch.setState({ rows: rowsFor(shown.text, []) });
  };
  refreshFallback = setTimeout(() => searchPresented(session), REFRESH_WITHOUT_PRESENTATION_MS);
}

function feedSourcesQuietly() {
  const key = currentSourcesKey();
  if (key === fedSources) return;
  fedSources = key;
  const profile = selectedProfile();
  const local = history().summary();
  setSources(buildSources(spaceTabs(currentTabs()), profile ? mergeSyncedHistory(local, profile.history) : local, profile ? syncedBookmarks(profile) : []));
}

export function feedSources() {
  if (currentSourcesKey() === fedSources) return;
  feedSourcesQuietly();
  const shown = useSearch.getState();
  if (shown.open && !shown.text.trim()) useSearch.setState({ rows: rowsFor(shown.text, []) });
}

function suggestionsFor(text: string, remoteValues: readonly string[]): { rows: TrayRow[]; completion: string } {
  if (!text.trim()) return { rows: rowsFor(text, remoteValues), completion: "" };
  return suggest(text, remoteValues, context, macTabIndex(selectedProfile(), syncData().view.devices), browseForMeOffered());
}

function rowsFor(text: string, remoteValues: readonly string[]): TrayRow[] {
  const profile = selectedProfile();
  if (text.trim()) return suggest(text, remoteValues, context, macTabIndex(profile, syncData().view.devices), browseForMeOffered()).rows;
  return withPasteRow(idleRowsNow(), text, paste);
}

function offerPaste(session: number) {
  void settled(() => clipboardOffer(), null).then((offer) => {
    const state = useSearch.getState();
    if (!offer || !state.open || state.session !== session) return;
    paste = offer;
    if (!state.text.trim()) useSearch.setState({ rows: rowsFor(state.text, []) });
  });
}

export function beginPasteRead(): number | null {
  const { open, session } = useSearch.getState();
  if (!open || pasteReadIn === session) return null;
  pasteReadIn = session;
  return session;
}

export function endPasteRead(session: number, pasted: boolean): boolean {
  if (pasteReadIn === session) pasteReadIn = null;
  const state = useSearch.getState();
  if (!state.open || state.session !== session) return false;
  if (!pasted) {
    paste = null;
    if (!state.text.trim()) useSearch.setState({ rows: rowsFor(state.text, []) });
  }
  return true;
}

export const refreshSearchRows = () => useSearch.setState((state) => ({ rows: rowsFor(state.text, []) }));

export function applySearchEngine() {
  const { status, view } = syncData();
  if (status.isEnabled && view.search) setSyncedSearch(view.search);
  else setSearchEngine(currentPreferences().searchEngineId);
}

export function presentSearch(origin: SearchOrigin, text = "", incognitoOnCancel: boolean | null = null, page: SuggestContext | null = null, arrival: TrayArrival = "rises") {
  markSearchPressed();
  beginInteraction("tray open", INTERACTION_WINDOW_MS.trayOpen);
  inFlight?.abort();
  remote = { text: "", values: [] };
  context = page ?? { currentUrl: null, currentTabId: null };
  paste = null;
  const editsPage = page?.currentUrl != null;
  const shownText = editsPage && clearsPagePrefill ? "" : text;
  if (!shownText.trim() && !idleMade.has(idleScope()) && !useTabs.getState().incognito) countUsage("search_opens_cold");
  useSearch.setState((state) => ({
    open: true,
    ending: "cancelled",
    origin,
    initialText: text,
    text: shownText,
    rows: rowsAtPress(shownText),
    completion: "",
    completedFor: "",
    session: state.session + 1,
    fieldVersion: 0,
    incognitoOnCancel,
    arrival,
    editsPage,
  }));
  markSearchPhase("open");
  offerPaste(useSearch.getState().session);
  refreshAfterOpening(useSearch.getState().session);
}

export function dismissSearch(ending: SearchEnding = "cancelled") {
  if (useSearch.getState().open) markSearchClosing();
  inFlight?.abort();
  useSearch.setState({ open: false, ending, incognitoOnCancel: null });
}

const REMOTE_DELAY_MS = 150;

let typed: string | null = null;
let frame: ReturnType<typeof requestAnimationFrame> | null = null;
let remoteTimer: ReturnType<typeof setTimeout> | null = null;

function showRows(text: string) {
  catchUpSources();
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

function catchUpSources() {
  if (pendingRefresh === null) return;
  feedSourcesQuietly();
}

export const searchState = () => useSearch.getState();
