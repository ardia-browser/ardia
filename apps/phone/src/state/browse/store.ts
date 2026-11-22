import { Platform } from "react-native";
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
import { forgetPosition, saveTabPosition, watchFrontScroll } from "./positions";
import { noteLocalChange, showSpace } from "../sync/store";
import { spaceToShow, tabsInSpace } from "../tabs/spaces";
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
  loadTabs,
  openNewTab,
  reopenClosedTab,
  restoreArchivedTab,
  selectTabById,
  setIncognito,
  rewriteTab,
  updateTabById,
  useTabs,
} from "../tabs/store";
import { labTrace } from "../../platform/lab";
import { pictureCaptured, pictureLanded } from "../tabs/pictures";
import { deckOrder, findTab, isPrivateOnScreen, isPrivateTab, selectedTab, tabBefore } from "../tabs/tabsState";
import { setHidesFromRecents } from "../../platform/links";
import { copyText, pasteForGo } from "../../platform/system";
import { pasteTap } from "../search/pasteRow";
import { anyPicturePainted, noteSnapshotPageTop, noteSnapshotShown, pictureKey, picturePainted } from "../../lib/shownSnapshots";
import { DECK_PULL } from "../../lib/deckPull";
import { runOnUI } from "react-native-reanimated";
import { showToast } from "../toasts/store";
import { PRIVATE_PAGES_UNAVAILABLE, refuseIncognito } from "../tabs/privatePages";
import { hideArchiveCard } from "./archiveCard";
import { cutDeckPullFromRest, deckPull, deckPullArmed, deckPullFades, deckPullGrowing, deckStandbyId, endDeckPull, fadeDeckPullFromRest, landDeckPullFromRest, noteDeckPullEntrance, PULL_STAGE, showPulledPage, whenDeckStandby } from "./deckPull";
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

type BrowseState = { surface: Surface; sheet: Sheet; deckEntrance: string | null; frozenOrder: string[] | null; opening: string | null; openingCardWidth: number | null; veiled: string | null; covered: string | null; arriving: string | null; leaving: string | null };

export const useBrowse = create<BrowseState>()(() => ({ surface: "start", sheet: null, deckEntrance: null, frozenOrder: null, opening: null, openingCardWidth: null, veiled: null, covered: null, arriving: null, leaving: null }));

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
  watchFrontScroll(frontPageId, pictureScrolledOrQuietPage);
  if (!currentPreferences().hasFinishedOnboarding) showOnboarding();
  else if (currentPreferences().autoOpensKeyboard) presentSearch("home", "", useTabs.getState().incognito, null, "atRest");
}

let appActive = true;

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
  useBrowse.setState({ opening: id, openingCardWidth: cardWidth, veiled: veiled ? id : null, covered: veiled ? id : null, arriving: null, leaving: null });
}

export function unveilOpeningPage(id: string) {
  if (useBrowse.getState().veiled === id) useBrowse.setState({ veiled: null });
}

const drawnWaiters = new Map<string, () => void>();

export function whenPageDrawn(id: string, capMs: number, then: (drawn: boolean) => void): () => void {
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

export const pageDrawn = (id: string) => drawnWaiters.get(id)?.();

export const OPENING_COVER_ID = "openingCover";

export const ARRIVAL_COVER_ID = "pagerArrivalCover";

export type CoverHidden = "drawn" | "cap" | "lost";

const coverWaiters = new Map<string, (reason: CoverHidden) => void>();

export function whenPageCoverHidden(id: string, capMs: number, then: (reason: CoverHidden) => void): () => void {
  let called = false;
  const stop = () => {
    called = true;
    clearTimeout(cap);
    if (coverWaiters.get(id) === hidden) coverWaiters.delete(id);
  };
  const hidden = (reason: CoverHidden) => {
    if (called) return;
    stop();
    then(reason);
  };
  const cap = setTimeout(() => hidden("lost"), capMs);
  coverWaiters.set(id, hidden);
  return stop;
}

export const pageCoverHidden = (id: string, reason: "drawn" | "cap") => coverWaiters.get(id)?.(reason);

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

export function openTab(id: string) {
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
  void captureSnapshot(id);
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

export function deckPullBegan(id: string, tracked = true) {
  const tab = findTab(currentTabs(), id);
  if (tab?.snapshotFileName) noteSnapshotShown(tab.snapshotFileName);
  if (tracked) {
    trackedPull = id;
    pullBusySince = Date.now();
    beginInteraction(PULL_PERF, INTERACTION_WINDOW_MS.deckPull);
  }
  if (PULL_COPIES_PAGE) latchDeckCapture(id, pageCovered(), PULLED_PAGE_TOP, false);
  else deckCapture = null;
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
    deckPullBegan(id, false);
    beginInteraction(PULL_LANDING_PERF, INTERACTION_WINDOW_MS.deckPullLanding);
    runOnUI(deckPullFades() ? (cardShowsPicture(id) ? fadeDeckPullFromRest : cutDeckPullFromRest) : landDeckPullFromRest)(id, deckPullSettled, deckPullRefused);
    runOnUI(markNextUiFrame)("deck motion");
    runOnUI(markNextUiFrame)("deck takes taps");
  });
}

function cardShowsPicture(id: string) {
  const picture = findTab(currentTabs(), id)?.snapshotFileName;
  return picture != null && picturePainted(pictureKey(`deck:${id}`, picture));
}

function deckPullRefused(id: string) {
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

export function deckPullSettled(id: string, landed: boolean, worstFrameMs = 0, openAfter = "") {
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
  if (!cardPictureShown(id)) {
    if (pullCounts(id)) countUsage("deck_pictures_late");
    labTrace("PAGELAB deck pull handed over before its card had a picture painted");
  }
  if (useBrowse.getState().surface !== "browsing" || currentTabs().selectedId !== id) {
    if (deckPullGrowing() === null) endDeckPull();
    return;
  }
  dismissSearch();
  noteDeckPullEntrance(id);
  labTrace(`PAGELAB deck shown with ${currentTabs().open.length} tabs, ${currentTabs().privates.length} private`);
  markTiming("deck taps");
  useBrowse.setState({ surface: "deck", deckEntrance: null, frozenOrder: null, opening: null, veiled: null, covered: null, leaving: null });
  if (!openAfter || !findTab(currentTabs(), openAfter)) return;
  labTrace("PAGELAB deck card tapped while the deck landed opens as it lands");
  if (pullCounts(openAfter)) countUsage("deck_opens_while_landing");
  sendDeckCommand({ kind: "open", tabId: openAfter, tappedAt: tappedAt ?? Date.now() });
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
  restoreArchivedTab(tab);
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
let stopArrivalWait: (() => void) | null = null;

function cancelArrivalWait() {
  const stop = stopArrivalWait;
  stopArrivalWait = null;
  stop?.();
}

export function arriveAtNeighbour(id: string) {
  const order = swipeOrder();
  const from = currentTabs().selectedId;
  cancelArrivalWait();
  useBrowse.setState({ frozenOrder: order });
  openTab(id);
  useBrowse.setState({ covered: id, arriving: id });
  stopArrivalWait = whenPageCoverHidden(id, ARRIVAL_COVER_LOST_MS, () => {
    stopArrivalWait = null;
    if (useBrowse.getState().arriving === id) useBrowse.setState({ arriving: null, covered: useBrowse.getState().covered === id ? null : useBrowse.getState().covered });
  });
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

export async function captureSnapshot(id: string, pageTop: number | null = null, latched = false): Promise<boolean> {
  if (!latched && !snapshotAllowed(id)) return false;
  const countable = pictureCountable(id);
  const taken = await snapshotPage(id, !latched);
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
      if (snapshotAllowed(id)) void captureSnapshot(id);
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
  for (const id of [...lastVisits.keys(), ...loading.keys()]) {
    if (findTab(tabs, id)) continue;
    lastVisits.delete(id);
    loading.delete(id);
    forgetPosition(id);
    clearTimeout(snapshotTimers.get(id));
    snapshotTimers.delete(id);
  }
});

export function goBackToStartIfEmpty() {
  if (useBrowse.getState().surface === "browsing" && !selectedTab(currentTabs())) show("start");
}
