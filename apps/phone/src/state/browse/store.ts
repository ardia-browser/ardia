import { Dimensions, Platform } from "react-native";
import { create } from "zustand";
import { history } from "../history/store";
import { HISTORY_RETENTION_MS } from "../history/historySummary";
import { useLibrary } from "../library/store";
import {
  clearTone,
  isRefusedSnapshot,
  livePageIds,
  listenToPages,
  pageNavigation,
  settled,
  snapshotIsCurrent,
  snapshotPage,
  storeNavigation,
  type SnapshotTiming,
  storeTone,
  type PageEngineEvent,
  type PageState,
  type PageTone,
} from "../pages/store";
import type { VisitKind } from "../../platform/pages";
import { showOnboarding, useOnboarding } from "../onboarding/store";
import { pageUi } from "../page/store";
import { settingsNav } from "../settings/nav";
import { refreshDefaultBrowser } from "../settings/defaultBrowser";
import { forgetPosition, frontScrollCameToRest, saveTabPosition, watchFrontScroll } from "./positions";
import { noteLocalChange, showSpace } from "../sync/store";
import { isSplit, spaceToShow, tabsInSpace } from "../tabs/spaces";
import { currentPreferences, loadPreferences, setPreference } from "../settings/store";
import type { VisitTransition, Visit } from "../store/browserDatabase";
import { enterTarget, rowTarget, resolve, type TrayRow } from "../search/omnibox";
import { applySearchEngine, dismissSearch, presentSearch, refreshSearchRows, searchState, useSearch, beginPasteRead, endPasteRead } from "../search/store";
import {
  archiveDueTabs,
  loadArchive,
  pruneExpiredArchive,
  closeEveryTab,
  closePrivateTabs,
  closeTabById,
  currentTabs,
  flushTabWrites,
  loadTabs,
  onTabWritesStalled,
  tabWritesPending,
  openNewTab,
  reopenClosedTab,
  restoreArchivedTab,
  selectTabById,
  setIncognito,
  rewriteTab,
  updateTabById,
  useTabs,
} from "../tabs/store";
import { labTrace, traceSlice } from "../../platform/lab";
import { pictureCaptured, pictureLanded } from "../tabs/pictures";
import { noteViewMoved, noteWarmPicture } from "../tabs/warmPictures";
import { deckOrder, findTab, isPrivateOnScreen, isPrivateTab, selectedTab, tabBefore } from "../tabs/tabsState";
import { setHidesFromRecents } from "../../platform/links";
import { copyText, pasteForGo } from "../../platform/system";
import { pasteTap } from "../search/pasteRow";
import { anyPicturePainted, noteSnapshotPageTop, noteSnapshotShown, pictureKey, picturePainted } from "../../lib/shownSnapshots";
import { DECK_PULL } from "../../lib/deckPull";
import { tabWords } from "../../lib/sharedWords";
import { runOnJS, runOnUI } from "react-native-reanimated";
import { showToast } from "../toasts/store";
import { PRIVATE_PAGES_UNAVAILABLE, refuseIncognito } from "../tabs/privatePages";
import { hideArchiveCard } from "./archiveCard";
import { tabSwitchCuts } from "./tabSwitch";
import { cutDeckPullFromRest, deckPull, deckPullArmed, deckPullFades, deckPullGrowing, deckStandbyId, endDeckPull, fadeDeckPullFromRest, landDeckPullFromRest, noteDeckPullEntrance, pageBarPreviewShown, pageBarShown, pageBodyShown, peekDeckPullEntrance, previewPageBar, PULL_STAGE, restorePageAfterRefusedCut, showPulledPage, whenDeckStandby } from "./deckPull";
import { advancePhoneGeneration, currentPhoneGeneration, deckHitLive, settleDeckCommand, deckReadyFor, deckRevisionOf, deckTurn, noteDeckRevision, deckTurnReconciled, dropDeckHits, noteDeckTurnReconciled, queueDeckHit, type DeckHitCommand } from "./deckTurn";
import { useScreenLayout } from "../app/screenLayout";
import { dropEarlyStandby } from "../search/standbyReveal";
import { beginInteraction, cutInteraction, INTERACTION_WINDOW_MS, markNextUiFrame, markTiming } from "../app/interactionPerf";
import { refreshHiddenDeck, wantDeckStandby } from "./deckStandby";
import { sendDeckCommand } from "./deckCommands";
import { countUsage } from "../telemetry/telemetry";
import { startBrowseForMe } from "../browseForMe/store";
import { rememberPageTones, restorePageTones } from "../pages/toneMemory";
import { followColorInWidgets } from "../settings/widgetColor";
import { coverIsCapturable, isSyncableUrl, pageStatePatch, titleAfterFailedLoad, type BrowserTab, type TabOrigin } from "../tabs/tabModels";
import { syncOffered } from "../../platform/system";

export type Surface = "start" | "browsing" | "deck";
export type Sheet = "archive" | "spaces" | null;

type BrowseState = { surface: Surface; sheet: Sheet; deckEntrance: string | null; frozenOrder: string[] | null; opening: string | null; openingCardWidth: number | null; veiled: string | null; covered: string | null; arriving: string | null; arrivalCover: string | null; openingCover: string | null; leaving: string | null };

export const useBrowse = create<BrowseState>()(() => ({ surface: "start", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, openingCardWidth: null, veiled: null, covered: null, arriving: null, arrivalCover: null, openingCover: null, leaving: null }));

const lastVisits = new Map<string, Visit>();

const SNAPSHOT_SETTLE_MS = 700;
const SNAPSHOT_RETRIES = 30;
const STATE_SAVE_DELAY_MS = 1500;

let started = false;

export function startBrowser(beforeOpening: () => void = () => undefined) {
  if (started) return;
  started = true;
  loadPreferences();
  followColorInWidgets();
  beforeOpening();
  applySearchEngine();
  loadTabs();
  restorePageTones(new Set(currentTabs().open.map((tab) => tab.id)));
  rememberPageTones(() => new Set(currentTabs().open.map((tab) => tab.id)));
  history().pruneBefore(Date.now() - HISTORY_RETENTION_MS);
  archiveDueTabs();
  archiveTimer = setInterval(archiveDueTabs, AUTO_ARCHIVE_CHECK_MS);
  listenToPages(pageEvent);
  onTabWritesStalled(() => showToast(tabWords.notSaved, "warning"));
  if (!SCROLL_REST_IS_REPORTED) watchFrontScroll(frontPageId, pictureScrolledOrQuietPage);
  if (!currentPreferences().hasFinishedOnboarding) showOnboarding();
  else if (currentPreferences().autoOpensKeyboard) presentSearch("home", "", useTabs.getState().incognito, null, "atRest");
}

let appActive = true;

const SCROLL_REST_IS_REPORTED = Platform.OS === "ios";

function frontPageId() {
  if (!appActive || useBrowse.getState().surface !== "browsing" || pageCovered()) return null;
  return currentTabs().selectedId;
}

export function pageCovered() {
  const ui = pageUi();
  return (
    searchState().open ||
    ui.menuOpen ||
    ui.readerTabId !== null ||
    ui.press !== null ||
    useLibrary.getState().open ||
    settingsNav().open ||
    useOnboarding.getState().showing ||
    useBrowse.getState().sheet !== null
  );
}

let archiveTimer: ReturnType<typeof setInterval> | null = null;

const AUTO_ARCHIVE_CHECK_MS = 15 * 60_000;

export function appBecameActive() {
  appActive = true;
  if (tabWritesPending()) flushTabWrites();
  if (pruneExpiredArchive() > 0) loadArchive();
  if (archiveTimer) clearInterval(archiveTimer);
  archiveTimer = setInterval(archiveDueTabs, AUTO_ARCHIVE_CHECK_MS);
  void refreshDefaultBrowser();
  const selected = currentTabs().selectedId;
  if (selected) selectTabById(selected);
  archiveDueTabs();
}

export function appWillResignActive() {
  appActive = false;
  if (archiveTimer) clearInterval(archiveTimer);
  archiveTimer = null;
  const selected = currentTabs().selectedId;
  if (selected) selectTabById(selected);
  flushTabWrites();
  void savePageStates();
}

const show = (surface: Surface) => {
  showPulledPage();
  useBrowse.setState({ surface });
};

export function openPage(url: string, origin: TabOrigin) {
  showPulledPage();
  takeLeavingPicture(null);
  dismissSearch("submitted");
  const tab = openNewTab({ url, origin });
  if (origin === "search" && !tab.isPrivate) countUsage("searches");
  useBrowse.setState({ surface: "browsing", sheet: null, frozenOrder: null });
}

export function submitSearch(text: string): boolean {
  const target = enterTarget(text);
  if (!target) return false;
  openPage(target.url, target.origin);
  return true;
}

export function searchFor(query: string) {
  const trimmed = query.trim();
  const resolution = trimmed ? resolve(`?${trimmed}`) : null;
  if (resolution) openPage(resolution.url, "search");
}

export function activateRow(row: TrayRow) {
  if (row.kind === "browseForMe") {
    startBrowseForMe(row.query);
    return;
  }
  if (row.kind === "calc") {
    copyCalculation(row.value);
    return;
  }
  if (row.kind === "paste") {
    const session = beginPasteRead();
    if (session === null) return;
    const startedIncognito = useTabs.getState().incognito;
    void settled(() => pasteForGo(), "").then((pasted) => {
      const tap = pasteTap(pasted, (text) => enterTarget(text)?.origin === "typed");
      if (!endPasteRead(session, tap.go !== null)) return;
      if (!startedIncognito && !useTabs.getState().incognito) countUsage(tap.count);
      if (tap.go) submitSearch(tap.go);
    });
    return;
  }
  if (row.kind === "page" && row.tabId && findTab(currentTabs(), row.tabId)) {
    openTab(row.tabId);
    return;
  }
  const target = rowTarget(row);
  if (target) openPage(target.url, target.origin);
}

function copyCalculation(value: string) {
  void settled(() => copyText(value), undefined);
  showToast(`Copied ${value}`, "calculation");
}

function showSpaceOf(id: string) {
  const data = currentTabs();
  const space = spaceToShow(data.spaces, findTab(data, id));
  if (space) showSpace(space);
}

export function beginOpeningTab(id: string, veiled = false, cardWidth: number | null = null) {
  showSpaceOf(id);
  setIncognito(isPrivateTab(currentTabs(), id));
  selectTabById(id);
  cancelArrivalWait();
  openingSeq += 1;
  earlyCoverHides.delete(id);
  useBrowse.setState({ opening: id, openingCardWidth: cardWidth, veiled: veiled ? id : null, covered: veiled ? id : null, openingCover: veiled ? `${OPENING_COVER_ID}-${openingSeq}` : null, arriving: null, leaving: null });
}

export function unveilOpeningPage(id: string) {
  if (useBrowse.getState().veiled === id) useBrowse.setState({ veiled: null });
}

const drawnWaiters = new Map<string, () => void>();

const drawnPages = new Map<string, number | null>();

export const notePageHosted = (id: string) => void drawnPages.delete(id);

export const pageWasDrawn = (id: string) => drawnPages.has(id);

export function documentWasDrawn(id: string) {
  if (!drawnPages.has(id)) return false;
  const drawn = drawnPages.get(id) ?? null;
  const shown = pageNavigation(id)?.document;
  return drawn === null || shown === undefined || drawn === shown;
}

const drawnListeners = new Map<string, Set<() => void>>();

export function listenForPageDrawn(id: string, listener: () => void): () => void {
  const listeners = drawnListeners.get(id) ?? new Set<() => void>();
  listeners.add(listener);
  drawnListeners.set(id, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && drawnListeners.get(id) === listeners) drawnListeners.delete(id);
  };
}

export function whenPageDrawn(id: string, capMs: number, then: (drawn: boolean) => void): () => void {
  if (drawnPages.has(id)) {
    then(true);
    return () => undefined;
  }
  let called = false;
  const stop = () => {
    called = true;
    clearTimeout(cap);
    if (drawnWaiters.get(id) === drawn) drawnWaiters.delete(id);
  };
  const finish = (wasDrawn: boolean) => {
    if (called) return;
    stop();
    then(wasDrawn);
  };
  const drawn = () => finish(true);
  const cap = setTimeout(() => finish(false), capMs);
  drawnWaiters.set(id, drawn);
  return stop;
}

export function pageDrawn(id: string, document?: number) {
  drawnPages.set(id, document ?? null);
  drawnWaiters.get(id)?.();
  for (const listener of [...(drawnListeners.get(id) ?? [])]) listener();
}

export const OPENING_COVER_ID = "openingCover";

export const ARRIVAL_COVER_ID = "pagerArrivalCover";

export type CoverHidden = "drawn" | "cap" | "lost";

type CoverWaiter = { cover: string | null; hidden: (reason: CoverHidden) => void };

const coverWaiters = new Map<string, Map<string, CoverWaiter>>();

const coverKey = (cover: string | null) => cover ?? "";

export function whenPageCoverHidden(id: string, capMs: number, then: (reason: CoverHidden) => void, cover: string | null = null): () => void {
  const early = earlyCoverHides.get(id);
  if (early && coverMatches(cover, early.cover, early.found, early.document)) {
    earlyCoverHides.delete(id);
    then(early.reason);
    return () => undefined;
  }
  let called = false;
  const stop = () => {
    called = true;
    clearTimeout(cap);
    const waiting = coverWaiters.get(id);
    if (waiting?.get(coverKey(cover)) !== waiter) return;
    waiting.delete(coverKey(cover));
    if (waiting.size === 0) coverWaiters.delete(id);
  };
  const hidden = (reason: CoverHidden) => {
    if (called) return;
    stop();
    then(reason);
  };
  const waiter: CoverWaiter = { cover, hidden };
  const cap = setTimeout(() => hidden("lost"), capMs);
  const waiting = coverWaiters.get(id) ?? new Map<string, CoverWaiter>();
  waiting.set(coverKey(cover), waiter);
  coverWaiters.set(id, waiting);
  return stop;
}

const COUNTS_CAPPED_COVERS = Platform.OS === "ios";

type EarlyCoverHide = { cover: string | undefined; reason: "drawn" | "cap"; found: boolean; document: number | undefined };

const earlyCoverHides = new Map<string, EarlyCoverHide>();

const COVER_NAMES_ITS_DOCUMENT = Platform.OS === "android";

function coverMatches(expected: string | null, cover: string | undefined, found: boolean, document: number | undefined) {
  if (expected === null) return true;
  if (COVER_NAMES_ITS_DOCUMENT && document === undefined) return false;
  return cover === expected && found;
}

export function pageCoverHidden(id: string, reason: "drawn" | "cap", cover?: string, found = true, document?: number) {
  const waiting = coverWaiters.get(id);
  if (!waiting || waiting.size === 0) {
    earlyCoverHides.set(id, { cover, reason, found, document });
    return;
  }
  for (const waiter of [...waiting.values()]) if (coverMatches(waiter.cover, cover, found, document)) waiter.hidden(reason);
}

let openingSeq = 0;

let arrivalSeq = 0;

const laidOutWaiters = new Map<string, (laidOut: boolean) => void>();

export function whenPageLaidOut(id: string, capMs: number, then: (laidOut: boolean) => void) {
  laidOutWaiters.get(id)?.(false);
  let called = false;
  const done = (laidOut: boolean) => {
    if (called) return;
    called = true;
    clearTimeout(cap);
    if (laidOutWaiters.get(id) === done) laidOutWaiters.delete(id);
    then(laidOut);
  };
  const cap = setTimeout(() => done(false), capMs);
  laidOutWaiters.set(id, done);
}

export const pageLaidOut = (id: string) => laidOutWaiters.get(id)?.(true);

export function stopOpeningTab(id: string) {
  if (useBrowse.getState().opening === id) useBrowse.setState({ opening: null, veiled: null, covered: null });
}

let cutCard: { id: string; width: number } | null = null;

export type BarAction = "address" | "more" | "plus" | "tabs";

let heldBarAction: { id: string; action: BarAction; scope: string } | null = null;

export function holdBarAction(id: string, action: BarAction, scope: string) {
  heldBarAction = { id, action, scope };
}

export function carryHeldBarAction(run: () => void) {
  const held = heldBarAction;
  run();
  if (held && heldBarAction === null) heldBarAction = held;
}

export function dropBarAction(scope: string) {
  if (heldBarAction?.scope === scope) heldBarAction = null;
}

export function takeBarAction(scope: string, id: string): BarAction | null {
  const held = heldBarAction;
  heldBarAction = null;
  if (!held || held.scope !== scope || held.id !== id) return null;
  return held.action;
}

export function noteCutCard(id: string, width: number) {
  cutCard = { id, width };
}

export function clearCutCard() {
  cutCard = null;
}

export function takeCutCardWidth(id: string) {
  if (cutCard?.id !== id) return null;
  const width = cutCard.width;
  cutCard = null;
  return width;
}

let committedBarAction: { id: string; action: BarAction } | null = null;

export function commitBarAction(id: string, action: BarAction) {
  committedBarAction = { id, action };
}

export function takeCommittedBarAction(id: string): BarAction | null {
  const committed = committedBarAction;
  committedBarAction = null;
  return committed && committed.id === id ? committed.action : null;
}

export function openTab(id: string) {
  heldBarAction = null;
  committedBarAction = null;
  const tabs = currentTabs();
  if (!tabs.open.some((tab) => tab.id === id) && !tabs.privates.some((tab) => tab.id === id)) return;
  showPulledPage();
  takeLeavingPicture(id);
  hideArchiveCard();
  dismissSearch();
  showSpaceOf(id);
  if (!setIncognito(isPrivateTab(currentTabs(), id))) {
    closePrivateTabs();
    useBrowse.setState({ surface: "start", sheet: null, opening: null, veiled: null, covered: null });
    return;
  }
  if (currentTabs().selectedId !== id) selectTabById(id);
  useBrowse.setState({ surface: "browsing", sheet: null, opening: null, veiled: null, covered: null, leaving: null });
  const tab = findTab(currentTabs(), id);
  if (tab && !tab.snapshotFileName && loading.get(id) === false) scheduleSnapshot(id);
}

function trayOrigin() {
  return useBrowse.getState().surface === "start" ? "start" : "page";
}

export function newTab() {
  presentSearch(trayOrigin(), "", useTabs.getState().incognito);
}

export function newIncognitoTab() {
  const was = useTabs.getState().incognito;
  if (!setIncognito(true)) return;
  presentSearch(trayOrigin(), "", was);
}

export function newRegularTab() {
  const was = useTabs.getState().incognito;
  setIncognito(false);
  presentSearch(trayOrigin(), "", was);
}

export function switchDeckIncognito() {
  const was = useTabs.getState().incognito;
  if (setIncognito(!was) && !was) countUsage("deck_incognito_switches");
}

export function toggleTrayIncognito() {
  const was = useTabs.getState().incognito;
  if (searchState().incognitoOnCancel === null) useSearch.setState({ incognitoOnCancel: was });
  if (!setIncognito(!was)) return;
  if (!was) countUsage("tray_incognito_switches");
  refreshSearchRows();
}

export function cancelSearch() {
  const { incognitoOnCancel, origin } = searchState();
  dismissSearch();
  const selected = currentTabs().selectedId;
  if (origin === "home" && useBrowse.getState().surface === "start" && selected) {
    openTab(selected);
    return;
  }
  if (incognitoOnCancel !== null) setIncognito(incognitoOnCancel);
}

function deckCutFromTap(id: string, phone: number) {
  if (phone !== currentPhoneGeneration()) return;
  markTiming("deck press");
  landingFromRest = id;
  pullBusySince = Date.now();
  traceSlice("deck cut from tap");
  deckPullBegan(id, false, true);
  beginInteraction(PULL_LANDING_PERF, INTERACTION_WINDOW_MS.deckPullLanding);
}

function deckTapCutRefused(id: string, phone: number) {
  if (phone !== currentPhoneGeneration()) {
    labTrace("PAGELAB deck tap refused for an earlier screen layout, nothing opens");
    return;
  }
  if (landingFromRest === id) landingFromRest = null;
  void showDeck();
}

export function tabsPressedOnPhone(phone: number, press: () => void) {
  if (phone !== currentPhoneGeneration()) {
    labTrace("PAGELAB Tabs press dropped, it was made in an earlier screen layout");
    return;
  }
  press();
}

export function canCutDeckFromTap(id: string): boolean {
  "worklet";
  return deckPull.target.value?.id === id && deckPull.stage.value === PULL_STAGE.idle && deckReadyFor(id);
}

export function cutDeckFromTabsTap(id: string) {
  "worklet";
  runOnJS(deckCutFromTap)(id, deckTurn.phone.value);
  cutDeckPullFromRest(id, deckPullSettled, deckTapCutRefused);
}

export async function showDeck() {
  markTiming("deck press");
  const { surface } = useBrowse.getState();
  const selected = currentTabs().selectedId;
  if (selected && pullBusyWith(selected)) return;
  if (surface === "deck" && deckPullGrowing() !== null) return;
  if (surface === "browsing" && deckPullGrowing() !== null) endDeckPull();
  if (surface === "browsing" && selected && deckPullArmed() === selected && !pageCovered()) {
    landDeckFromRest(selected);
    return;
  }
  enterDeck();
}

let entranceSeq = 0;

function enterDeck() {
  entranceSeq += 1;
  cutCard = null;
  const { surface } = useBrowse.getState();
  const selected = currentTabs().selectedId;
  const covered = pageCovered();
  dismissSearch();
  if (surface === "browsing" && selected) {
    const tab = findTab(currentTabs(), selected);
    if (tab?.snapshotFileName) noteSnapshotShown(tab.snapshotFileName);
    latchDeckCapture(selected, covered, null, CAPTURES_AFTER_MOTION && deckPullArmed() !== selected);
  }
  const leaving = surface === "browsing" ? selected : null;
  labTrace(`PAGELAB deck shown with ${currentTabs().open.length} tabs, ${currentTabs().privates.length} private`);
  useBrowse.setState({ surface: "deck", deckEntrance: leaving, frozenOrder: null, opening: null, veiled: null, covered: null, leaving });
}

type DeckCapture = { id: string; pageTop: number | null; done: Promise<void> | null };

let deckCapture: DeckCapture | null = null;
let landingFromRest: string | null = null;
let trackedPull: string | null = null;
let pullBusySince = 0;

const PULL_STALE_MS = 1500;

function revokePhoneTurnOnUI() {
  "worklet";
  deckPull.hitTurn.value += 1;
  deckPull.target.value = null;
  deckPull.hit.value = null;
  deckPull.awayId.value = "";
  pageBarShown.value = 1;
  pageBodyShown.value = 1;
  pageBarPreviewShown.value = 0;
}

export function screenLayoutChanged() {
  landingFromRest = null;
  trackedPull = null;
  heldBarAction = null;
  committedBarAction = null;
  landingTapAt = null;
  entranceSeq += 1;
  if (deckCapture && !deckCapture.done) deckCapture = null;
  if (peekDeckPullEntrance() && useBrowse.getState().surface === "deck") useBrowse.setState({ surface: "browsing", deckEntrance: null, leaving: null });
  noteDeckPullEntrance(null);
  noteDeckTurnReconciled(0);
  dropDeckHits();
  advancePhoneGeneration();
  endDeckPull();
  runOnUI(revokePhoneTurnOnUI)();
  previewPageBar(null);
  dropEarlyStandby();
}

let deckRevision = "";
const followDeckRevision = (tabs: ReturnType<typeof useTabs.getState>) => {
  const next = deckRevisionOf(tabs.incognito, isSplit(tabs.spaces) ? tabs.spaces.current : null);
  if (next === deckRevision) return;
  deckRevision = next;
  noteDeckRevision(next);
};
followDeckRevision(useTabs.getState());
useTabs.subscribe(followDeckRevision);

let phoneLayout = useScreenLayout.getState().layout.name === "phone";
useScreenLayout.subscribe((state) => {
  const phone = state.layout.name === "phone";
  if (phone === phoneLayout) return;
  phoneLayout = phone;
  screenLayoutChanged();
});

function pullBusyWith(id: string) {
  if (landingFromRest !== id && trackedPull !== id) return false;
  const stage = deckPull.stage.value;
  if (stage === PULL_STAGE.tracking || stage === PULL_STAGE.landing || stage === PULL_STAGE.returning || Date.now() - pullBusySince < PULL_STALE_MS) return true;
  labTrace("PAGELAB deck pull left waiting with nothing in flight, a new request takes over");
  landingFromRest = null;
  trackedPull = null;
  return false;
}

const CAPTURES_AFTER_MOTION = Platform.OS === "android";
const PULL_COPIES_PAGE = Platform.OS !== "android";
const CAPTURE_HOLDS_PAGE_MS = 400;

const pullCounts = (id: string) => !useTabs.getState().incognito && !findTab(currentTabs(), id)?.isPrivate;

const PULL_PERF = "deck pull";
const PULLED_PAGE_TOP = 0;
const PULL_LANDING_PERF = "deck pull landing";

const pictureIsCurrent = (id: string) => Boolean(findTab(currentTabs(), id)?.snapshotFileName) && snapshotIsCurrent(id) === true;

export function keepFrontPictureCurrent() {
  const id = currentTabs().selectedId;
  if (!id || useBrowse.getState().surface !== "browsing" || deckPullInFlight() || deckPullGrowing() !== null) return;
  if (!coverIsCapturable(loading.get(id) === false, pageCovered()) || !snapshotAllowed(id) || pictureIsCurrent(id)) return;
  labTrace(`PAGELAB snapshot ${id} taken while the page is quiet`);
  void captureSnapshot(id, null, false, "quiet");
}

function latchDeckCapture(id: string, covered: boolean, pageTop: number | null, afterMotion: boolean) {
  deckCapture = null;
  if (!coverIsCapturable(loading.get(id) === false, covered) || !frontPageShown(id) || pictureIsCurrent(id)) return;
  if (pullCounts(id)) countUsage("deck_pictures_at_press");
  const latched: DeckCapture = { id, pageTop, done: null };
  deckCapture = latched;
  if (!afterMotion) void takeDeckCapture(latched);
}

function takeDeckCapture(latched: DeckCapture) {
  if (latched.done) return latched.done;
  latched.done = captureSnapshot(latched.id, latched.pageTop, true).then(() => {
    if (deckCapture === latched) deckCapture = null;
    const fresh = findTab(currentTabs(), latched.id)?.snapshotFileName;
    if (fresh) noteSnapshotShown(fresh);
  });
  return latched.done;
}

const cardPictureShown = (id: string) => {
  const picture = findTab(currentTabs(), id)?.snapshotFileName ?? null;
  return picture === null || picturePainted(pictureKey(`deck:${id}`, picture)) || anyPicturePainted(`deck:${id}`);
};

export function deckMotionDone(id: string) {
  if (!cardPictureShown(id) && pullCounts(id)) countUsage("deck_pictures_late");
  const latched = deckCapture?.id === id ? deckCapture : null;
  if (!latched || latched.done) {
    deckEntered(id);
    return;
  }
  const entrance = entranceSeq;
  let entered = false;
  const enter = () => {
    if (entered) return;
    entered = true;
    clearTimeout(hold);
    if (entrance === entranceSeq) deckEntered(id);
  };
  const hold = setTimeout(enter, CAPTURE_HOLDS_PAGE_MS);
  void takeDeckCapture(latched).then(enter);
}

export function deckPullBegan(id: string, tracked = true, captureLater = false) {
  const tab = findTab(currentTabs(), id);
  if (tab?.snapshotFileName) noteSnapshotShown(tab.snapshotFileName);
  if (tracked) {
    trackedPull = id;
    pullBusySince = Date.now();
    beginInteraction(PULL_PERF, INTERACTION_WINDOW_MS.deckPull);
  }
  if (!PULL_COPIES_PAGE) deckCapture = null;
  else if (captureLater) requestAnimationFrame(() => latchDeckCapture(id, pageCovered(), PULLED_PAGE_TOP, false));
  else latchDeckCapture(id, pageCovered(), PULLED_PAGE_TOP, false);
}

export function deckPullReleased(id: string, lands: boolean) {
  pullBusySince = Date.now();
  cutInteraction(PULL_PERF);
  beginInteraction(lands ? PULL_LANDING_PERF : "deck pull return", INTERACTION_WINDOW_MS.deckPullLanding);
  if (pullCounts(id)) countUsage(lands ? "deck_bar_swipes" : "deck_bar_swipes_returned");
}

function landDeckFromRest(id: string) {
  landingFromRest = id;
  pullBusySince = Date.now();
  if (deckStandbyId() !== id) {
    labTrace("PAGELAB deck pull asks the hidden deck for this page");
    refreshHiddenDeck();
    wantDeckStandby();
  }
  whenDeckStandby(id, (ready) => {
    if (landingFromRest !== id) return;
    if (useBrowse.getState().surface !== "browsing" || currentTabs().selectedId !== id) {
      landingFromRest = null;
      labTrace("PAGELAB deck pull dropped, its page is no longer in front");
      return;
    }
    if (!ready) {
      landingFromRest = null;
      labTrace("PAGELAB deck pull found no hidden deck for this page, the deck opens without it");
      enterDeck();
      return;
    }
    if (tabSwitchCuts()) {
      traceSlice("deck cut");
      runOnUI(cutDeckPullFromRest)(id, deckPullSettled, deckPullRefused);
      deckPullBegan(id, false, true);
      beginInteraction(PULL_LANDING_PERF, INTERACTION_WINDOW_MS.deckPullLanding);
      runOnUI(markNextUiFrame)("deck motion");
      runOnUI(markNextUiFrame)("deck takes taps");
      return;
    }
    deckPullBegan(id, false);
    beginInteraction(PULL_LANDING_PERF, INTERACTION_WINDOW_MS.deckPullLanding);
    runOnUI(tabSwitchCuts() ? cutDeckPullFromRest : deckPullFades() ? (cardShowsPicture(id) ? fadeDeckPullFromRest : cutDeckPullFromRest) : landDeckPullFromRest)(id, deckPullSettled, deckPullRefused);
    runOnUI(markNextUiFrame)("deck motion");
    runOnUI(markNextUiFrame)("deck takes taps");
  });
}

function cardShowsPicture(id: string) {
  const picture = findTab(currentTabs(), id)?.snapshotFileName;
  return picture != null && picturePainted(pictureKey(`deck:${id}`, picture));
}

function deckPullRefused(id: string, phone: number) {
  if (phone !== currentPhoneGeneration()) {
    labTrace("PAGELAB deck pull refused for an earlier screen layout, dropped");
    return;
  }
  if (landingFromRest !== id) return;
  landingFromRest = null;
  if (trackedPull !== null || useBrowse.getState().surface !== "browsing" || currentTabs().selectedId !== id) return;
  deckCapture = null;
  labTrace("PAGELAB deck pull refused on the UI thread, the deck opens without it");
  enterDeck();
}

let landingTapAt: number | null = null;

export function noteDeckTapWhileLanding(at: number) {
  landingTapAt = at;
}

export function deckPullSettled(id: string, landed: boolean, worstFrameMs: number, openAfter: string, turn: number, phone: number) {
  if (phone !== currentPhoneGeneration()) {
    labTrace("PAGELAB deck pull settled for an earlier screen layout, dropped");
    return;
  }
  const tappedAt = landingTapAt;
  landingTapAt = null;
  labTrace(`PAGELAB deck pull animation ${landed ? "landed" : "returned"}`);
  if (landingFromRest === id) landingFromRest = null;
  if (trackedPull === id) trackedPull = null;
  if (worstFrameMs > DECK_PULL.hitchMs && pullCounts(id)) countUsage("deck_pulls_hitched");
  if (!landed) {
    if (deckCapture?.id === id && !deckCapture.done) deckCapture = null;
    refreshHiddenDeck();
    return;
  }
  if (deckCapture?.id === id) void takeDeckCapture(deckCapture);
  if (deckTurnReconciled(turn)) return;
  if (!cardPictureShown(id)) {
    if (pullCounts(id)) countUsage("deck_pictures_late");
    labTrace("PAGELAB deck pull handed over before its card had a picture painted");
  }
  if (!enterDeckOnTurn(id, turn)) return;
  if (!openAfter || !findTab(currentTabs(), openAfter)) return;
  labTrace("PAGELAB deck card tapped while the deck landed opens as it lands");
  if (pullCounts(openAfter)) countUsage("deck_opens_while_landing");
  sendDeckCommand({ kind: "open", tabId: openAfter, tappedAt: tappedAt ?? Date.now() });
}

function enterDeckOnTurn(id: string, turn: number): boolean {
  if (useBrowse.getState().surface !== "browsing" || currentTabs().selectedId !== id) {
    labTrace("PAGELAB deck cut refused in JS, its page is no longer in front, the page gets its bar and body back");
    if (turn !== 0) restorePageAfterRefusedCut(turn);
    else if (deckPullGrowing() === null) endDeckPull();
    return false;
  }
  noteDeckTurnReconciled(turn);
  dismissSearch();
  noteDeckPullEntrance({ id, turn, phone: currentPhoneGeneration() });
  labTrace(`PAGELAB deck shown with ${currentTabs().open.length} tabs, ${currentTabs().privates.length} private`);
  markTiming("deck taps");
  useBrowse.setState({ surface: "deck", deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, leaving: null });
  return true;
}

export function deckHitAccepted(hit: DeckHitCommand) {
  if (hit.phone !== currentPhoneGeneration()) {
    labTrace(`PAGELAB ${hit.label} dropped, it was pressed in an earlier screen layout`);
    return;
  }
  if (!deckHitLive(hit)) {
    labTrace(`PAGELAB ${hit.label} dropped, its deck turn is over or already took a command`);
    settleDeckCommand(hit.turn);
    return;
  }
  traceSlice(hit.label);
  markTiming("deck hit");
  if (!deckTurnReconciled(hit.turn)) {
    if (landingFromRest === hit.deck) landingFromRest = null;
    if (!enterDeckOnTurn(hit.deck, hit.turn)) {
      settleDeckCommand(hit.turn);
      return;
    }
    labTrace(`PAGELAB ${hit.label} reached JS before the deck's entrance, both apply together`);
  }
  if (queueDeckHit(hit) && hit.control === "card" && hit.tabId && pullCounts(hit.tabId)) countUsage("deck_opens_while_landing");
}

const pullBusy = () => {
  const id = landingFromRest ?? trackedPull;
  return id !== null && pullBusyWith(id);
};

export const deckPullCommitted = () => deckPull.stage.value === PULL_STAGE.landing || (landingFromRest !== null && pullBusy());

export const deckPullInFlight = () => pullBusy();

export const peekDeckEntrance = () => useBrowse.getState().deckEntrance;

export const consumeDeckEntrance = () => {
  const entrance = useBrowse.getState().deckEntrance;
  if (entrance) useBrowse.setState({ deckEntrance: null });
  return entrance;
};

export function deckEntered(id: string) {
  if (useBrowse.getState().leaving === id) useBrowse.setState({ leaving: null });
}

export function leaveDeck() {
  const tab = selectedTab(currentTabs());
  if (tab) openTab(tab.id);
  else show("start");
}

export function leaveDeckIfEmpty() {
  const tabs = currentTabs();
  if (useBrowse.getState().surface !== "deck" || tabsInSpace(tabs.open, tabs.spaces).length + tabs.privates.length > 0) return;
  show("start");
}

export function closeTabFromDeck(id: string) {
  closeTabById(id);
  leaveDeckIfEmpty();
}

export function stayIncognito() {
  if (!useTabs.getState().incognito) setIncognito(true);
}

export function closeAllFromDeck() {
  closeEveryTab();
  leaveDeckIfEmpty();
}

export const leaveIncognito = () => closePrivateTabs();

export function reopenLastClosed() {
  const tab = reopenClosedTab();
  if (tab) openTab(tab.id);
}

export function swipedPastHistory(id: string, direction: "back" | "forward") {
  if (useBrowse.getState().surface !== "browsing" || currentTabs().selectedId !== id) return;
  if (direction === "forward") {
    const tab = reopenClosedTab();
    if (!tab) return;
    if (!tab.isPrivate) countUsage("tabs_swiped_reopened");
    openTab(tab.id);
    return;
  }
  const closing = findTab(currentTabs(), id);
  const previous = tabBefore(currentTabs(), id);
  if (previous) selectTabById(previous.id);
  closeTabById(id);
  if (closing && !closing.isPrivate) countUsage("tabs_swiped_closed");
  if (previous) openTab(previous.id);
  else show("start");
}

export function pageOpenFailed(id: string, code: string) {
  if (code !== PRIVATE_PAGES_UNAVAILABLE || !isPrivateTab(currentTabs(), id)) return;
  const wasShowing = useBrowse.getState().surface === "browsing" && currentTabs().selectedId === id;
  refuseIncognito();
  if (searchState().open) dismissSearch();
  closePrivateTabs();
  if (wasShowing) show("start");
}

export const openArchive = () => useBrowse.setState({ sheet: "archive" });

let sheetFromSettings = false;

export const markSheetFromSettings = () => {
  sheetFromSettings = useBrowse.getState().sheet !== null;
};

export const takeSheetFromSettings = () => {
  const was = sheetFromSettings;
  sheetFromSettings = false;
  return was;
};

export const closeArchive = () => {
  sheetFromSettings = false;
  useBrowse.setState({ sheet: null });
};

export const openSpaces = () => {
  if (syncOffered()) useBrowse.setState({ sheet: "spaces" });
};

export function reopenArchived(tab: BrowserTab) {
  if (!restoreArchivedTab(tab)) return;
  openTab(tab.id);
}

export function swipeOrder(): string[] {
  const live = deckOrder(currentTabs()).map((t) => t.id);
  const frozen = useBrowse.getState().frozenOrder;
  if (!frozen) return live;
  const alive = new Set(live);
  const kept = frozen.filter((id) => alive.has(id));
  const known = new Set(kept);
  return [...kept, ...live.filter((id) => !known.has(id))];
}

export function switchToNeighbour(id: string, swiped = false) {
  const order = swipeOrder();
  const from = currentTabs().selectedId;
  useBrowse.setState({ frozenOrder: order });
  openTab(id);
  if (swiped) noteTabSwiped(from, id);
}

export const swipeToNeighbour = (id: string) => switchToNeighbour(id, true);

const ARRIVAL_COVER_LOST_MS = 400;
const CUT_ARRIVAL_HELD_MS = 4_000;
let stopArrivalWait: (() => void) | null = null;

function cancelArrivalWait() {
  const stop = stopArrivalWait;
  stopArrivalWait = null;
  stop?.();
}

export function arriveAtNeighbour(id: string, onScreen = false) {
  const order = swipeOrder();
  const from = currentTabs().selectedId;
  cancelArrivalWait();
  useBrowse.setState({ frozenOrder: order });
  openTab(id);
  if (currentTabs().selectedId !== id) return;
  if (onScreen && pageWasDrawn(id)) {
    const now = useBrowse.getState();
    if (now.arriving !== null || now.arrivalCover !== null) useBrowse.setState({ arriving: null, arrivalCover: null });
    noteTabSwiped(from, id);
    return;
  }
  arrivalSeq += 1;
  earlyCoverHides.delete(id);
  const cover = `${ARRIVAL_COVER_ID}-${arrivalSeq}`;
  useBrowse.setState({ covered: id, arriving: id, arrivalCover: cover });
  const waitForDrawn = (): (() => void) =>
    whenPageCoverHidden(
    id,
    tabSwitchCuts() ? CUT_ARRIVAL_HELD_MS : ARRIVAL_COVER_LOST_MS,
    (reason) => {
      stopArrivalWait = null;
      const still = useBrowse.getState();
      if (reason === "lost" && tabSwitchCuts() && still.arriving === id && still.arrivalCover === cover) {
        labTrace(`PAGELAB arrival ${id} still unconfirmed after ${CUT_ARRIVAL_HELD_MS} ms, its card stays and waits again`);
        stopArrivalWait = waitForDrawn();
        return;
      }
      if (COUNTS_CAPPED_COVERS && reason !== "drawn" && !isPrivateTab(currentTabs(), id) && !useTabs.getState().incognito) countUsage("page_covers_capped");
      const now = useBrowse.getState();
      if (now.arriving === id && now.arrivalCover === cover) useBrowse.setState({ arriving: null, arrivalCover: null, covered: now.covered === id ? null : now.covered });
    },
    cover,
  );
  stopArrivalWait = waitForDrawn();
  noteTabSwiped(from, id);
}

export const arrivalCovers = (id: string) => {
  const { arriving, covered } = useBrowse.getState();
  return arriving === id && covered === id;
};

function noteTabSwiped(from: string | null, to: string) {
  if (!currentPreferences().tabSwipeHintShown) setPreference("tabSwipeHintShown", true);
  const tabs = currentTabs();
  if ((from === null || !isPrivateTab(tabs, from)) && !isPrivateTab(tabs, to)) countUsage("tabs_bar_swiped");
}

const transitions: Record<VisitKind, VisitTransition | null> = {
  typed: "typed",
  link: "link",
  sameDocument: "link",
  backForward: "backForward",
  redirect: "other",
  restored: null,
};

let stateSave: ReturnType<typeof setTimeout> | null = null;

function saveFrontTabSoon(id: string) {
  if (currentTabs().selectedId !== id) return;
  if (stateSave) clearTimeout(stateSave);
  stateSave = setTimeout(() => {
    stateSave = null;
    if (!findTab(currentTabs(), id) || currentTabs().selectedId !== id) return;
    void saveTabPosition(id);
  }, STATE_SAVE_DELAY_MS);
}

function pageVisited(id: string, url: string, reported: string, kind: VisitKind) {
  const tab = findTab(currentTabs(), id);
  if (!tab) return;
  const title = pageNavigation(id)?.failure ? "" : reported;
  if (kind !== "restored") saveFrontTabSoon(id);
  if (isSyncableUrl(url)) updateTabById(id, { url, title: title.trim() ? title : undefined });
  const transition = transitions[kind];
  if (!transition || tab.isPrivate) return;
  const visit = history().record(url, title, transition, tab.profileSyncId, Date.now());
  if (visit) {
    lastVisits.set(id, visit);
    noteLocalChange();
  }
}

function pageEvent(event: PageEngineEvent) {
  if (event.name === "page.visited") pageVisited(event.pageId, event.url, event.title, event.kind);
  else if (event.name === "page.state" && currentTabs().selectedId !== event.pageId) backgroundPageState(event.pageId, event.state);
  else if (event.name === "page.closeRequested") closeTabById(event.pageId);
  else if (event.name === "page.snapshotLanded") snapshotLanded(event.pageId, event.uri, event.generation);
  else if (event.name === "page.viewMoved") noteViewMoved(event.pageId, event.viewId, event.view);
  else if (event.name === "page.scrollSettled") frontScrollCameToRest(event.pageId, event.y, frontPageId(), pictureScrolledOrQuietPage);
}

const loading = new Map<string, boolean>();
const snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();

function takeLeavingPicture(nextId: string | null) {
  const leaving = currentTabs().selectedId;
  if (!leaving || leaving === nextId || useBrowse.getState().surface !== "browsing" || loading.get(leaving) !== false || !coverIsCapturable(true, pageCovered())) return;
  clearTimeout(snapshotTimers.get(leaving));
  snapshotTimers.delete(leaving);
  void captureSnapshot(leaving);
}

export function captureCurrentCover() {
  const id = currentTabs().selectedId;
  if (!id || !coverIsCapturable(loading.get(id) === false, false)) return;
  void captureSnapshot(id);
}

const exactCaptureStarted = new Map<string, number>();
const publishedCaptureStarted = new Map<string, number>();
let captureClock = 0;

const captureIsStale = (id: string, startedAt: number, timing: SnapshotTiming) =>
  (publishedCaptureStarted.get(id) ?? 0) > startedAt || (timing === "quiet" && (exactCaptureStarted.get(id) ?? 0) > startedAt);

export async function captureSnapshot(id: string, pageTop: number | null = null, latched = false, timing: SnapshotTiming = "now"): Promise<boolean> {
  if (!latched && !snapshotAllowed(id)) return false;
  const countable = pictureCountable(id);
  const startedAt = ++captureClock;
  if (timing === "now") exactCaptureStarted.set(id, startedAt);
  const capturedUrl = findTab(currentTabs(), id)?.url ?? "";
  const capturedWindow = Dimensions.get("window");
  const taken = await snapshotPage(id, !latched, timing);
  if (captureIsStale(id, startedAt, timing)) {
    labTrace(`PAGELAB snapshot ${id} dropped, a newer one was taken after it`);
    return false;
  }
  const counts = countable && pictureCountable(id);
  if (taken && isRefusedSnapshot(taken)) {
    pictureRefused(id, taken.refused, counts);
    return false;
  }
  const snapshot = taken;
  if (snapshot) pictureSaved(id, snapshot.route, counts);
  const pulled = (deckCapture?.id === id && deckCapture.pageTop !== null) || deckPullGrowing() === id;
  const top = pageTop ?? (pulled ? PULLED_PAGE_TOP : null);
  if (snapshot && top !== null) noteSnapshotPageTop(snapshot.uri, top);
  else if (snapshot?.frame) noteSnapshotPageTop(snapshot.uri, snapshot.frame.y);
  const tab = snapshot ? findTab(currentTabs(), id) : null;
  if (!snapshot || !tab) return false;
  const step = pictureCaptured(tab, snapshot.uri, snapshot.durable !== false, snapshot.generation);
  if (step) publishedCaptureStarted.set(id, startedAt);
  if (step && step.show === snapshot.uri) noteWarmPicture(id, { uri: snapshot.uri, url: capturedUrl, window: capturedWindow, frame: snapshot.frame, settled: snapshot.viewSettled, view: snapshot.view, viewId: snapshot.viewId, generation: snapshot.generation });
  if (step && tab.snapshotFileName !== step.show) {
    updateTabById(id, { snapshotFileName: step.show });
    showHiddenDeckThePicture(id);
  }
  return step !== null;
}

function pictureScrolledOrQuietPage(id: string) {
  pictureScrolledPage(id);
  keepFrontPictureCurrent();
}

function pictureScrolledPage(id: string) {
  if (Platform.OS !== "android" || loading.get(id) !== true || !coverIsCapturable(true, pageCovered())) return;
  const countable = pictureCountable(id);
  void captureSnapshot(id).then((published) => {
    if (published && countable && pictureCountable(id)) countUsage("page_pictures_scrolled");
  });
}

function pictureCountable(id: string) {
  const tab = findTab(currentTabs(), id);
  return tab !== undefined && !tab.isPrivate && !useTabs.getState().incognito;
}

function pictureSaved(id: string, route: string | undefined, counts: boolean) {
  labTrace(`PAGELAB snapshot ${id} saved by ${route ?? "unknown"}`);
  if (route === "engine" && counts) countUsage("page_pictures_webkit");
}

function pictureRefused(id: string, reason: "hidden" | "blank", counts: boolean) {
  labTrace(`PAGELAB snapshot ${id} refused: page ${reason}, the card keeps its last picture`);
  if (!counts) return;
  countUsage(reason === "blank" ? "page_pictures_blank" : "page_pictures_hidden");
}

function showHiddenDeckThePicture(id: string) {
  if (currentTabs().selectedId === id && useBrowse.getState().surface === "browsing" && !deckPullInFlight()) refreshHiddenDeck();
}

function snapshotLanded(id: string, uri: string, generation: number) {
  const tab = findTab(currentTabs(), id);
  if (!tab) return;
  const landed = pictureLanded(tab, uri, generation);
  if (!landed) return;
  if (landed === "shown" && tab.snapshotFileName !== uri) {
    updateTabById(id, { snapshotFileName: uri });
    showHiddenDeckThePicture(id);
  } else rewriteTab(id);
}

function frontPageShown(id: string) {
  if (currentTabs().selectedId !== id) return true;
  return useBrowse.getState().surface === "browsing" && !pageCovered();
}

function snapshotAllowed(id: string) {
  if (currentTabs().selectedId !== id) return true;
  return frontPageShown(id) && !deckPullInFlight() && deckPullGrowing() === null;
}

function scheduleSnapshot(id: string, tries = SNAPSHOT_RETRIES) {
  clearTimeout(snapshotTimers.get(id));
  snapshotTimers.set(
    id,
    setTimeout(() => {
      snapshotTimers.delete(id);
      if (!findTab(currentTabs(), id)) return;
      const selected = currentTabs().selectedId === id;
      if (selected && useBrowse.getState().surface !== "browsing") return;
      if (snapshotAllowed(id)) void captureSnapshot(id, null, false, "quiet");
      else if (tries > 0) scheduleSnapshot(id, tries - 1);
    }, SNAPSHOT_SETTLE_MS),
  );
}

function backgroundPageState(id: string, state: PageState) {
  const tab = findTab(currentTabs(), id);
  if (!tab) return;
  noteCrash(tab, state);
  keepTitleThroughFailure(tab, state);
  const patch = pageStatePatch(tab, state, false);
  if (patch) updateTabById(id, patch);
  const wasLoading = loading.get(id);
  loading.set(id, state.isLoading);
  if (wasLoading && !state.isLoading) scheduleSnapshot(id);
}

const crashedPages = new Set<string>();

const titlesBeforeLoad = new Map<string, string>();

function keepTitleThroughFailure(tab: BrowserTab, state: PageState) {
  if (state.isLoading && !loading.get(tab.id) && !state.failure) titlesBeforeLoad.set(tab.id, tab.title);
  if (!state.failure) return;
  clearTone(tab.id);
  const title = titleAfterFailedLoad(titlesBeforeLoad.get(tab.id), tab.title);
  if (title !== null) updateTabById(tab.id, { title });
}

function noteCrash(tab: BrowserTab, state: PageState) {
  if (state.failure?.kind !== "crashed") {
    crashedPages.delete(tab.id);
    return;
  }
  if (crashedPages.has(tab.id)) return;
  crashedPages.add(tab.id);
  if (!tab.isPrivate) countUsage("page_processes_gone");
}

export function pageStateChanged(id: string, state: PageState) {
  storeNavigation(id, state);
  const tab = findTab(currentTabs(), id);
  if (!tab) return;
  noteCrash(tab, state);
  keepTitleThroughFailure(tab, state);
  const title = state.failure ? null : state.title.trim() ? state.title : null;
  const patch = pageStatePatch(tab, state, true);
  if (patch) updateTabById(id, patch);
  const visit = lastVisits.get(id);
  if (visit && title && visit.url === state.url && visit.title !== title) lastVisits.set(id, history().amend(visit, { title }));
  const wasLoading = loading.get(id);
  loading.set(id, state.isLoading);
  if (wasLoading && !state.isLoading) scheduleSnapshot(id);
}

export function pageToneChanged(id: string, tone: PageTone) {
  if (!pageNavigation(id)?.failure) storeTone(id, tone);
}

export async function savePageStates() {
  const live = new Set(await livePageIds());
  const data = currentTabs();
  for (const tab of [...data.open, ...data.privates]) {
    if (!live.has(tab.id)) continue;
    await saveTabPosition(tab.id);
  }
}

let hidesFromRecents = false;

useTabs.subscribe((tabs) => {
  const hides = isPrivateOnScreen(tabs, tabs.incognito);
  if (hides !== hidesFromRecents) {
    hidesFromRecents = hides;
    void settled(() => setHidesFromRecents(hides), false);
  }
  for (const id of drawnPages.keys()) if (!findTab(tabs, id)) drawnPages.delete(id);
  for (const id of [...lastVisits.keys(), ...loading.keys()]) {
    if (findTab(tabs, id)) continue;
    lastVisits.delete(id);
    loading.delete(id);
    forgetPosition(id);
    exactCaptureStarted.delete(id);
    publishedCaptureStarted.delete(id);
    clearTimeout(snapshotTimers.get(id));
    snapshotTimers.delete(id);
  }
});

export function goBackToStartIfEmpty() {
  if (useBrowse.getState().surface === "browsing" && !selectedTab(currentTabs())) show("start");
}
