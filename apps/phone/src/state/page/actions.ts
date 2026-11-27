import { blocking } from "../../platform/blocking";
import { downloads, type DownloadEvent } from "../../platform/downloads";
import { pages, type PageEngineEvent, type PageRequestAnswer } from "../../platform/pages";

export type { ReadableContent } from "../../platform/pages";
import { cleanLinkTitle, cleanUrl } from "@ardia/core/src/cleanUrl.ts";
import { copyLink, openExternal, preferredLanguage, pressHaptic, shareLink, sharePageWithPrint, successHaptic } from "../../platform/system";
import { cancelSearch, closeArchive, deckPullCommitted, openTab, showDeck, takeSheetFromSettings, useBrowse } from "../browse/store";
import { display } from "../search/omnibox";
import { prepareSearch, presentSearch, searchState } from "../search/store";
import { currentPreferences, setPreference } from "../settings/store";
import { designFor } from "../../lib/design";
import { Platform } from "react-native";
import { listenToPages, openPageInBackground, pageHandle, pageIsFullscreen, pageRequest, settled, storeFind, storeFullscreen, storeRequest, usePages } from "../pages/store";
import { closeTabById, currentTabs, openNewTab, useTabs } from "../tabs/store";
import { isSyncableUrl, type BrowserTab } from "../tabs/tabModels";
import { findTab } from "../tabs/tabsState";
import { blockersToast, searchQuery, translationAsks, translationUrl, type NightShadeMode } from "./pageMenu";
import { backLayer, downloadedToast, downloadFailedToast, downloadingToast, opensInInstaller, pressPlan, stoppedPrivateDownloadsToast, type PressAction, type Request } from "./pagePrompts";
import { installDownloadedPackage } from "../appUpdate/store";
import { onboardingBack } from "../onboarding/store";
import { refreshSettings } from "../settings/actions";
import { openSettings, openSettingsPage, popSettings, settingsNav, type SettingsRoute } from "../settings/nav";
import { pinToMac, sendTab } from "../sync/actions";
import type { SyncedDevice } from "../../platform/sync";
import { linkToCopy } from "./linkCopy";
import { pageUi, usePageUi, type MenuSite, type MenuTranslation, type Press, type TranslationAsk } from "./store";
import { endMenuTiming, markMenuPhase, markMenuPressed } from "./menuTiming";
import { markFindPhase, markFindPressed } from "./findTiming";
import { closeVoiceSearch, useVoice } from "../voice/store";
import { addOnlineAgainListener } from "../../platform/network";
import { countUsage } from "../telemetry/telemetry";
import { geminiNanoMissingCount, pageSummaryOpenedCount, pageSummarySettledCounts } from "../../lib/telemetrySchema";
import { pageSummariesEnabled, pageSummariesRevision, refreshPageSummariesEnabled } from "../pageSummary/enabled";
import { dismissArchiveCard } from "../browse/archiveCard";
import { copy } from "../../lib/platformCopy";
import { launchValues } from "../../platform/launch";
import { actionWords } from "../../lib/sharedWords";
import { syncData } from "../sync/store";
import { closeLibrary, libraryBack, openLibrary, useLibrary, type LibrarySection } from "../library/store";
import { showToast, TOAST_LONG_DURATION_MS } from "../toasts/store";
import { syncOffered } from "../../platform/system";

const TITLE_FEEDBACK_MS = 1000;
const NO_APP_FOR_LINK = "No App Can Open This Link";

const quietly = (call: () => Promise<unknown>) => void settled(call, undefined);

const selectedId = () => currentTabs().selectedId;
const selectedTab = () => {
  const id = selectedId();
  return id ? findTab(currentTabs(), id) ?? null : null;
};
const hostOf = (url: string | null) => (url ? display(url).host || null : null);

type MenuOpening = { id: number; tabId: string; host: string | null; isPrivate: boolean };
type MenuDocument = { opening: number; tabId: string; url: string };
type AfterMenu = MenuDocument & { run: () => void; sameDocument: boolean };

let openings = 0;
let opening: MenuOpening | null = null;
let afterMenu: AfterMenu | null = null;

const knownSites = new Map<string, MenuSite>();
const siteRevisions = new Map<string, number>();
let preparedSite: string | null = null;

const sameSite = (a: MenuSite | null, b: MenuSite) => a !== null && a.host === b.host && a.isPrivate === b.isPrivate && a.nightShade === b.nightShade && a.blockersEnabled === b.blockersEnabled;
const sameTranslation = (a: MenuTranslation | null, b: MenuTranslation) => a !== null && a.languageName === b.languageName && a.confirmed === b.confirmed;
const sameLevels = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((level, index) => level === b[index]);
const tabUrl = (tab: BrowserTab) => usePages.getState().navigation[tab.id]?.url ?? tab.url;
const siteKey = (host: string, isPrivate: boolean) => `${isPrivate ? "private" : "regular"} ${host}`;

function bumpSite(host: string | null, isPrivate: boolean): number {
  if (!host) return 0;
  const key = siteKey(host, isPrivate);
  const next = (siteRevisions.get(key) ?? 0) + 1;
  siteRevisions.set(key, next);
  return next;
}

const siteRevision = (host: string | null, isPrivate: boolean) => (host ? (siteRevisions.get(siteKey(host, isPrivate)) ?? 0) : 0);

type SiteRead = { site: MenuSite; revision: number };

const READ_FAILED = Symbol("site read failed");

async function readMenuSite(url: string, host: string | null, isPrivate: boolean): Promise<SiteRead | null> {
  const revision = bumpSite(host, isPrivate);
  const [shade, blockers] = await Promise.all([
    settled<Awaited<ReturnType<typeof pages.nightShade>> | typeof READ_FAILED>(() => pages.nightShade(host, isPrivate), READ_FAILED),
    settled<boolean | typeof READ_FAILED>(() => blocking.isEnabledForSite(url, isPrivate), READ_FAILED),
  ]);
  if (shade === READ_FAILED || blockers === READ_FAILED || siteRevision(host, isPrivate) !== revision) return null;
  const site: MenuSite = { host, isPrivate, nightShade: shade?.mode ?? "disabled", blockersEnabled: blockers };
  if (!isPrivate && host) knownSites.set(host, site);
  return { site, revision };
}

const readIsCurrent = (read: SiteRead) => siteRevision(read.site.host, read.site.isPrivate) === read.revision;

function publishSite(read: SiteRead | null) {
  if (!read || !readIsCurrent(read)) return;
  const { site } = read;
  const now = opening;
  const tab = selectedTab();
  if (!tab || tab.isPrivate !== site.isPrivate) return;
  if (pageUi().menuOpen ? !now || now.tabId !== tab.id || now.host !== site.host || !showsHost(now.tabId, site.host) : !showsHost(tab.id, site.host)) return;
  if (!sameSite(pageUi().menuSite, site)) usePageUi.setState({ menuSite: site });
}

function readOpeningSite(forOpening: MenuOpening, url: string) {
  return readMenuSite(url, forOpening.host, forOpening.isPrivate).then(publishSite);
}

function followOpenMenuHost() {
  const now = opening;
  const tab = selectedTab();
  if (!now || !pageUi().menuOpen || !tab || tab.id !== now.tabId) return;
  const url = tabUrl(tab);
  const host = hostOf(url);
  if (host === now.host) return;
  const moved: MenuOpening = { ...now, host };
  opening = moved;
  void readOpeningSite(moved, url).catch(() => undefined);
}

function writeSite(site: MenuSite): number {
  const revision = bumpSite(site.host, site.isPrivate);
  if (!site.isPrivate && site.host) knownSites.set(site.host, site);
  return revision;
}

function siteWriteFailed(site: MenuSite, revision: number, url: string) {
  if (siteRevision(site.host, site.isPrivate) !== revision) return;
  if (site.host && knownSites.get(site.host) === site) knownSites.delete(site.host);
  void readMenuSite(url, site.host, site.isPrivate).then(publishSite, () => undefined);
}

function showsHost(tabId: string, host: string | null) {
  const tab = selectedTab();
  return tab !== null && tab.id === tabId && hostOf(tabUrl(tab)) === host;
}

function showsDocument(document: MenuDocument) {
  const tab = selectedTab();
  return tab !== null && tab.id === document.tabId && tabUrl(tab) === document.url;
}

function currentDocument(): MenuDocument | null {
  const tab = selectedTab();
  if (!tab || !opening || opening.tabId !== tab.id) return null;
  return { opening: opening.id, tabId: tab.id, url: tabUrl(tab) };
}

export function preparePageMenu() {
  if (pageUi().menuOpen) return;
  const tab = selectedTab();
  if (!tab || tab.isPrivate) return;
  const navigation = usePages.getState().navigation[tab.id];
  if (!navigation || navigation.isLoading) return;
  const url = navigation.url ?? tab.url;
  const host = hostOf(url);
  if (!host || preparedSite === host) return;
  preparedSite = host;
  void readMenuSite(url, host, false).then(publishSite, () => undefined);
}

export const openPageMenu = () => showPageMenu(false);

async function showPageMenu(menuDocked: boolean) {
  const tab = selectedTab();
  if (!tab) return;
  markMenuPressed();
  afterMenu = null;
  const url = tabUrl(tab);
  const host = hostOf(url);
  const thisOpening: MenuOpening = { id: ++openings, tabId: tab.id, host, isPrivate: tab.isPrivate };
  opening = thisOpening;
  const shown = pageUi().menuSite;
  const known = tab.isPrivate || !host ? null : (knownSites.get(host) ?? null);
  const startSite = known && sameSite(shown, known) ? shown : known;
  usePageUi.setState({ menuOpen: true, menuOpening: thisOpening.id, menuPage: "main", menuDocked, titleFeedback: null, menuSite: startSite, translationAsk: null });
  markMenuPhase("open");
  if (menuDocked && !tab.isPrivate) countUsage("site_settings_sheet_opened");
  const [, capabilities, translation] = await Promise.all([
    readOpeningSite(thisOpening, url),
    settled(async () => pages.capabilities(), null),
    settled(() => pages.translation(), null),
  ]);
  if (!tab.isPrivate) preparedSite = host;
  if (opening?.id !== thisOpening.id || !showsHost(tab.id, opening.host)) return;
  const ui = pageUi();
  const levels = capabilities?.pageZoomLevels;
  const menuTranslation = translation && !sameTranslation(ui.menuTranslation, translation) ? { languageName: translation.languageName, confirmed: translation.confirmed } : ui.menuTranslation;
  const zoomLevels = levels && !sameLevels(levels, ui.zoomLevels) ? levels : ui.zoomLevels;
  if (menuTranslation !== ui.menuTranslation || zoomLevels !== ui.zoomLevels) usePageUi.setState({ menuTranslation, zoomLevels });
}

function menuSiteTarget() {
  const now = opening;
  const site = pageUi().menuSite;
  const tab = selectedTab();
  if (!now || !site?.host || !tab || tab.id !== now.tabId || site.host !== now.host || site.isPrivate !== tab.isPrivate || !showsHost(tab.id, site.host)) return null;
  return { tab, site, host: site.host, url: tabUrl(tab) };
}

export const closePageMenu = () => usePageUi.setState({ menuOpen: false, translationAsk: null });

export function pageMenuHidden(token: number | null = null) {
  const pending = afterMenu;
  if (!pending || pageUi().menuOpen || (token !== null && token !== pending.opening)) return;
  afterMenu = null;
  if (opening?.id !== pending.opening || (pending.sameDocument ? !showsDocument(pending) : selectedId() !== pending.tabId)) return;
  pending.run();
}

export const pageMenuHostGone = (token: number | null) => pageMenuHidden(token ?? opening?.id ?? null);

function afterPageMenu(run: () => void, { sameDocument = true }: { sameDocument?: boolean } = {}) {
  const document = currentDocument();
  if (!pageUi().menuOpen || !document) {
    afterMenu = null;
    run();
    return;
  }
  afterMenu = { ...document, run, sameDocument };
  closePageMenu();
}

export type MenuPresentation = { phase: "appear" | "disappear" | "release" | "dismiss"; token: number };

export const isCurrentShowing = (token: number) => token > 0 && token === pageUi().menuOpening;

const isKnownShowing = (token: number) => Number.isInteger(token) && token > 0 && token <= openings;

export function pageMenuPresentation({ phase, token }: MenuPresentation) {
  if (!isKnownShowing(token)) return;
  if (phase === "appear") {
    if (isCurrentShowing(token)) markMenuPhase("appeared");
    return;
  }
  if (phase === "release") {
    if (isCurrentShowing(token) && opening?.id === token && pageUi().menuOpen) closePageMenu();
    return;
  }
  if (phase === "disappear") {
    if (isCurrentShowing(token)) markFindPhase("menuGone");
    pageMenuHidden(token);
    return;
  }
  pageMenuHidden(token);
  if (!isCurrentShowing(token) || pageUi().menuOpen) return;
  endMenuTiming();
  if (pageUi().menuPage === "library") usePageUi.setState({ menuPage: "main" });
}

export function askTranslation() {
  const document = currentDocument();
  const tab = selectedTab();
  if (!document || !tab || !isSyncableUrl(document.url)) return;
  if (translationAsks(tab.isPrivate, pageUi().menuTranslation?.confirmed ?? false)) usePageUi.setState({ translationAsk: document });
  else translateDocument(tab, document.url);
}

export function confirmTranslation(asked: TranslationAsk | null = pageUi().translationAsk) {
  const live = pageUi().translationAsk;
  if (!asked || live !== asked) return;
  usePageUi.setState({ translationAsk: null });
  const tab = selectedTab();
  if (!tab || opening?.id !== asked.opening || !showsDocument(asked)) return;
  translateDocument(tab, asked.url);
}

export const cancelTranslationAsk = () => {
  if (pageUi().translationAsk) usePageUi.setState({ translationAsk: null });
};

export function releaseTranslationAsk(asked: TranslationAsk | null) {
  setTimeout(() => {
    if (asked && pageUi().translationAsk === asked) usePageUi.setState({ translationAsk: null });
  }, 0);
}

export function openLibraryInMenu(section: LibrarySection) {
  usePageUi.setState({ menuPage: "library" });
  openLibrary(section);
}

export const shareOverPageMenu = () => {
  const tab = selectedTab();
  if (!tab || !isSyncableUrl(tab.url)) return;
  const sharedFrom = opening;
  void shareFrom(tab)
    .catch(() => undefined)
    .finally(() => {
      if (opening === sharedFrom) closePageMenu();
    });
};

async function shareFrom(tab: BrowserTab) {
  if (!shareOffersPrint()) {
    await shareLink(cleanUrl(tab.url), cleanLinkTitle(tab.title, tab.url));
    return;
  }
  const activity = await sharePageWithPrint(tab.id, cleanUrl(tab.url), cleanLinkTitle(tab.title, tab.url));
  if (activity === PRINT_ACTIVITY && !tab.isPrivate) countUsage("pages_printed");
}

export function canPrintPages(): boolean {
  try {
    return pages.canPrint();
  } catch {
    return false;
  }
}

export function printCurrentPage() {
  const tab = selectedTab();
  const url = tab ? tabUrl(tab) : null;
  if (!tab || !url || !isSyncableUrl(url)) return;
  afterPageMenu(() =>
    quietly(async () => {
      if ((await pages.print(tab.id)) && !tab.isPrivate) countUsage("pages_printed");
    }),
  );
}

export function canSummarizePages(): boolean {
  try {
    return pages.canSummarize();
  } catch {
    return false;
  }
}

export function summarizeCurrentPage() {
  const tab = selectedTab();
  if (!tab || !pageSummariesEnabled()) return;
  const navigation = usePages.getState().navigation[tab.id];
  const url = navigation?.url ?? tab.url;
  if (!isSyncableUrl(url) || navigation?.isLoading) return;
  const revision = pageSummariesRevision();

  afterPageMenu(() => {
    if (!pageSummariesEnabled() || pageSummariesRevision() !== revision) return;
    const current = selectedTab();
    const latest = usePages.getState().navigation[tab.id];
    if (current?.id !== tab.id || useBrowse.getState().surface !== "browsing" || latest?.isLoading || (latest?.url ?? current.url) !== url) return;
    quietly(() => pages.summarize(tab.id));
  });
}

export function openInDefaultBrowser() {
  const tab = selectedTab();
  closePageMenu();
  const url = tab ? (usePages.getState().navigation[tab.id]?.url ?? tab.url) : null;
  if (url && isSyncableUrl(url)) quietly(() => openExternal(url));
}

export function pinCurrentToMac() {
  if (!syncOffered()) return;
  const tab = selectedTab();
  if (!tab) return;
  const inTitle = copy().pinFeedbackInMenu && syncData().status.isEnabled;
  if (!inTitle) closePageMenu();
  void pinToMac(tab, () => openSettings({ page: "sync" }), inTitle ? showTitleFeedback : null);
}

export function sendCurrentTab(device: SyncedDevice) {
  const tab = selectedTab();
  closePageMenu();
  if (tab) void sendTab(tab, device);
}

export function openSiteSettings() {
  usePageUi.setState({ menuPage: "siteSettings" });
  if (materialDesign()) void refreshSettings();
}

const materialDesign = () => designFor(Platform.OS, false, currentPreferences().materialYou) === "material";

export const openDockedSiteSettings = () => showPageMenu(true);

export const closeMenuSubpage = () => usePageUi.setState({ menuPage: "main" });

export function openSiteSettingsSheet() {
  afterPageMenu(() => openSettingsPage({ page: "siteSettings" }), { sameDocument: false });
}

function somethingElseOverPage(tabId: string) {
  const ui = pageUi();
  const browse = useBrowse.getState();
  return pageRequest(tabId) !== null || pageIsFullscreen(tabId) || ui.menuOpen || ui.findOpen || ui.readerTabId !== null || ui.press !== null || browse.surface !== "browsing" || browse.sheet !== null || searchState().open || settingsNav().open || useLibrary.getState().open || useVoice.getState().presented;
}

export function openSiteSettingsOverMenu() {
  const document = currentDocument();
  markMenuPhase("siteSettingsPressed");
  afterMenu = null;
  closePageMenu();
  const open = () => {
    markMenuPhase("siteSettingsOpened");
    openSettingsPage({ page: "siteSettings" });
  };
  if (!document) {
    open();
    return;
  }
  requestAnimationFrame(() => {
    if (opening?.id !== document.opening || selectedId() !== document.tabId || somethingElseOverPage(document.tabId)) return;
    open();
  });
}

export function openSiteSettingsRoute(route: SettingsRoute, { direct = false } = {}) {
  closePageMenu();
  openSettings(route, { direct });
}

const withPage = (run: (id: string) => Promise<unknown>) => {
  const id = selectedId();
  if (id) quietly(() => run(id));
};

export const menuBack = () => {
  closePageMenu();
  void pageHandle(selectedId())?.goBack();
};

export const menuForward = () => {
  closePageMenu();
  void pageHandle(selectedId())?.goForward();
};

export const menuReload = () => {
  closePageMenu();
  void pageHandle(selectedId())?.reload();
};

export const retryPage = (tabId: string) => void pageHandle(tabId)?.reload();

export function retryWhenOnline(tabId: string): () => void {
  const subscription = addOnlineAgainListener(() => {
    if (!findTab(currentTabs(), tabId)?.isPrivate) countUsage("pages_reloaded_online");
    retryPage(tabId);
  });
  return () => subscription.remove();
}

export const menuStop = () => void pageHandle(selectedId())?.stopLoading();

export function editPageQuery() {
  beginPageSearch("rises");
}

function beginPageSearch(arrival: "rises" | "dockedMenu") {
  const tab = selectedTab();
  if (!tab) return;
  if (arrival === "rises") closePageMenu();
  presentSearch("page", searchQuery(tab.url) ?? tab.url, null, { currentUrl: tab.url, currentTabId: tab.id }, arrival);
  if (arrival === "dockedMenu") closePageMenu();
}

function afterDockedMenu(run: () => void) {
  afterPageMenu(() => {
    if (useBrowse.getState().surface === "browsing") run();
  });
}

export const editDockedPageQuery = () => {
  if (pageUi().menuOpen) beginPageSearch("dockedMenu");
};

export function copyCurrentLink() {
  const tab = selectedTab();
  if (!tab || !isSyncableUrl(tab.url)) return;
  const link = linkToCopy(tab.url);
  quietly(() => copyLink(link.text));
  quietly(successHaptic);
  showTitleFeedback(link.acknowledgement);
}

export function showTitleFeedback(text: string) {
  usePageUi.setState({ titleFeedback: text });
  setTimeout(() => {
    if (pageUi().titleFeedback === text) usePageUi.setState({ titleFeedback: null });
  }, TITLE_FEEDBACK_MS);
}

const PRINT_ACTIVITY = "com.apple.UIKit.activity.Print";

export function shareOffersPrint(): boolean {
  try {
    return Platform.OS === "ios" && pages.sharesWithPrint();
  } catch {
    return false;
  }
}

export function shareCurrentPage() {
  const tab = selectedTab();
  if (!tab || !isSyncableUrl(tab.url)) return;
  closePageMenu();
  quietly(() => shareFrom(tab));
}

export function showReader() {
  const id = selectedId();
  if (!id) return;
  usePageUi.setState({ menuOpen: false, readerTabId: id });
}

export const closeReader = () => usePageUi.setState({ readerTabId: null });

export const readableContent = (id: string) => settled(() => pages.readableContent(id), null);

export const setReaderStep = (step: number) => setPreference("readerStep", step);
export const setReaderSerif = (serif: boolean) => setPreference("readerSerif", serif);
export const setReaderTheme = (theme: "light" | "sepia" | "dark") => setPreference("readerTheme", theme);

const usesSystemFind = () => {
  const value = launchValues().ArdiaAppFind;
  return value !== true && value !== "YES" && pages.hasSystemFind();
};

export function showFind() {
  const findIsPrivate = selectedTab()?.isPrivate ?? true;
  if (usesSystemFind()) {
    countUsage("find_opened_system");
    markFindPressed();
    const id = selectedId();
    closePageMenu();
    markFindPhase("menuClosing");
    if (!id) return;
    requestAnimationFrame(() => {
      if (selectedId() !== id) return;
      systemFindTab = id;
      quietly(async () => markFindPhase((await pages.presentSystemFind(id)) ? "navigatorVisible" : "navigatorPending"));
    });
    return;
  }
  countUsage("find_opened_bar");
  usePageUi.setState({ menuOpen: false, findOpen: true, findIsPrivate, findQuery: "" });
}

export function showDockedFind() {
  const tab = selectedTab();
  if (!tab) return;
  if (!tab.isPrivate) countUsage("find_opened_bar");
  afterDockedMenu(() => usePageUi.setState({ findOpen: true, findIsPrivate: tab.isPrivate, findQuery: "" }));
}

export function typeFind(query: string) {
  usePageUi.setState({ findQuery: query });
  withPage((id) => (query ? pages.find(id, query) : pages.endFind(id)));
}

export const findNext = () => withPage((id) => pages.findNext(id));
export const findPrevious = () => withPage((id) => pages.findPrevious(id));

export function closeFind() {
  const id = selectedId();
  if (pageUi().findOpen && !pageUi().findIsPrivate) countUsage("find_closed_bar");
  usePageUi.setState({ findOpen: false, findIsPrivate: true, findQuery: "" });
  if (id) {
    storeFind(id, null);
    quietly(() => pages.endFind(id));
  }
}

export function translatePage() {
  const tab = selectedTab();
  if (!tab || !isSyncableUrl(tabUrl(tab))) return;
  translateDocument(tab, tabUrl(tab));
}

function translateDocument(tab: BrowserTab, url: string) {
  closePageMenu();
  const { id, isPrivate } = tab;
  const translation = pageUi().menuTranslation;
  if (!isPrivate && translation && !translation.confirmed) usePageUi.setState({ menuTranslation: { ...translation, confirmed: true } });
  void (async () => {
    const remembered = await settled(() => pages.translationUrl(url), null);
    if (!isPrivate) {
      countUsage("pages_translated");
      await settled(() => pages.confirmTranslation(), undefined);
    }
    const now = findTab(currentTabs(), id);
    if (!now || tabUrl(now) !== url) return;
    await pageHandle(id)?.loadUrl(remembered ?? translationUrl(url, preferredLanguage()));
  })();
}

export function setNightShadeOn(on: boolean) {
  const target = menuSiteTarget();
  if (!target) return;
  const { tab, site, host, url } = target;
  const mode: NightShadeMode = on ? "always" : "disabled";
  const next = { ...site, nightShade: mode };
  const revision = writeSite(next);
  usePageUi.setState({ menuSite: next });
  void Promise.resolve()
    .then(() => pages.setNightShade(mode, host, tab.isPrivate))
    .catch(() => siteWriteFailed(next, revision, url));
}

export const zoomOut = () => withPage((id) => pages.zoomOut(id));
export const zoomIn = () => withPage((id) => pages.zoomIn(id));
export const resetZoom = () => withPage((id) => pages.setPageZoom(id, 1));

export function setDesktopSite(on: boolean) {
  closePageMenu();
  withPage((id) => pages.setDesktopSite(id, on));
}

export function setBlockersOn(on: boolean) {
  const target = menuSiteTarget();
  if (!target) return;
  const { tab, site, host, url } = target;
  closePageMenu();
  const next = { ...site, blockersEnabled: on };
  const revision = writeSite(next);
  quietly(async () => {
    const written = await settled(async () => {
      await blocking.setEnabledForSite(url, on, tab.isPrivate);
      return true;
    }, false);
    if (!written) {
      siteWriteFailed(next, revision, url);
      return;
    }
    showToast(blockersToast(on, host), on ? "blocking" : "warning");
    const now = findTab(currentTabs(), tab.id);
    if (now && tabUrl(now) === url) await pageHandle(tab.id)?.reload();
  });
}

export function answerRequest(pageId: string, request: Request, answer: PageRequestAnswer) {
  storeRequest(pageId, null);
  quietly(() => pages.answerRequest(pageId, request.id, answer));
}

export const dismissPress = () => usePageUi.setState({ press: null });

export function pressAction(press: Press, action: PressAction) {
  dismissPress();
  const opener = findTab(currentTabs(), press.tabId);
  const plan = pressPlan(press, action, opener?.isPrivate ?? false, isSyncableUrl);
  switch (plan.kind) {
    case "open": {
      const tab = openNewTab({ url: plan.url, origin: "link", after: plan.after, selecting: false, isPrivate: plan.isPrivate });
      if (plan.background) void openPageInBackground(tab.id, plan.url, plan.isPrivate);
      else openTab(tab.id);
      return;
    }
    case "copy": {
      const link = linkToCopy(plan.url);
      quietly(() => copyLink(link.text));
      quietly(successHaptic);
      showToast(link.acknowledgement, "link");
      return;
    }
    case "share":
      quietly(() => shareLink(cleanUrl(plan.url), cleanLinkTitle("", plan.url)));
      return;
    case "download":
      quietly(() => pages.download(plan.pageId, plan.url));
      return;
    case "none":
      return;
  }
}

async function openPopup(openerId: string, popupId: string, url: string | null, isPrivate: boolean, inBackground: boolean) {
  const tab = openNewTab({ url: url ?? "about:blank", origin: "link", after: openerId, selecting: false, isPrivate });
  const opened = await settled(() => pages.openPopup(tab.id, popupId), false);
  if (!opened) closeTabById(tab.id);
  else if (!inBackground) openTab(tab.id);
}

const PRIVATE_STOPS_GATHER_MS = 250;
let privateStops = 0;
let privateStopsTimer: ReturnType<typeof setTimeout> | null = null;

function notePrivateDownloadStopped() {
  privateStops += 1;
  if (privateStopsTimer) return;
  privateStopsTimer = setTimeout(() => {
    const count = privateStops;
    privateStops = 0;
    privateStopsTimer = null;
    showToast(stoppedPrivateDownloadsToast(count), "warning", TOAST_LONG_DURATION_MS);
  }, PRIVATE_STOPS_GATHER_MS);
}

function downloadEvent(event: DownloadEvent) {
  if (event.name !== "downloads.finished") return;
  if (event.failure === "privateSessionEnded") {
    notePrivateDownloadStopped();
    return;
  }
  if (event.failure) {
    showToast(downloadFailedToast(event.fileName), "warning");
    return;
  }
  const uri = event.uri;
  const open = opensInInstaller(Platform.OS, event.fileName) && downloads.installsPackages() ? (target: string) => quietly(async () => (await installDownloadedPackage(target)) || showToast("Couldn’t open the installer.", "warning")) : (target: string) => quietly(() => downloads.open(target));
  showToast(downloadedToast(event.fileName), "download", TOAST_LONG_DURATION_MS, uri ? { label: actionWords.open, run: () => open(uri) } : null);
}

function pageEvent(event: PageEngineEvent) {
  switch (event.name) {
    case "page.find":
      storeFind(event.pageId, event.result);
      return;
    case "page.request":
      storeRequest(event.pageId, event.request);
      return;
    case "page.fullscreen":
      storeFullscreen(event.pageId, event.isFullscreen);
      return;
    case "page.popup":
      void openPopup(event.pageId, event.popupId, event.url, event.isPrivate, event.inBackground === true);
      return;
    case "page.download":
      if (event.downloadId === null) showToast(downloadFailedToast(event.fileName), "warning");
      else showToast(downloadingToast(event.fileName), "download");
      return;
    case "page.longPress":
      if (event.pageId !== selectedId()) return;
      quietly(pressHaptic);
      usePageUi.setState({ press: { tabId: event.pageId, target: event.target, x: event.x, y: event.y } });
      return;
    case "page.externalAppMissing":
      showToast(NO_APP_FOR_LINK, "warning");
      return;
    case "page.summaryOpened": {
      const field = event.isPrivate ? null : pageSummaryOpenedCount(event.trigger);
      if (field) countUsage(field);
      return;
    }
    case "page.summarySettled":
      if (!event.isPrivate) for (const field of [...pageSummarySettledCounts(event.outcome, event.chatGPTFellBack), ...geminiNanoMissingCount(event.geminiNanoMissing)]) countUsage(field);
      return;
    case "pages.webVideo":
      if (!event.isPrivate) countUsage(event.outcome === "floated" ? "web_videos_floated" : "web_videos_kept_playing");
      return;
    default:
      return;
  }
}

let started = false;

export function startPageUi() {
  if (started) return;
  started = true;
  listenToPages(pageEvent);
  void refreshPageSummariesEnabled();
  try {
    downloads.addListener(downloadEvent);
  } catch {
    return;
  }
}

export const openInOtherApp = (url: string) => quietly(() => openExternal(url));

export function handleSystemBack(): boolean {
  if (onboardingBack()) return true;
  if (useVoice.getState().presented) {
    closeVoiceSearch();
    return true;
  }
  if (popSettings()) return true;
  if (libraryBack()) return true;
  const { surface, sheet } = useBrowse.getState();
  const id = selectedId();
  const ui = pageUi();
  if (searchState().open && surface !== "browsing") {
    cancelSearch();
    return true;
  }
  if (sheet) {
    const backToSettings = takeSheetFromSettings();
    closeArchive();
    if (backToSettings) openSettings();
    return true;
  }
  if (surface === "deck") return dismissArchiveCard();
  if (surface === "browsing" && deckPullCommitted()) return true;
  const layer = backLayer({
    isFullscreen: surface === "browsing" && pageIsFullscreen(id),
    hasRequest: surface === "browsing" && pageRequest(id) !== null,
    isSearching: searchState().open,
    hasPressMenu: ui.press !== null,
    isReading: ui.readerTabId !== null,
    isMenuOpen: ui.menuOpen,
    isOnMenuSubpage: ui.menuPage !== "main",
    isFinding: ui.findOpen,
    canGoBack: surface === "browsing" && Boolean(id && usePages.getState().navigation[id]?.canGoBack),
    hasTab: surface === "browsing" && id !== null,
  });
  switch (layer) {
    case "fullscreen":
      if (id) quietly(() => pages.exitFullscreen(id));
      return true;
    case "request": {
      const request = pageRequest(id);
      if (id && request) answerRequest(id, request as Request, { type: "dismiss" });
      return true;
    }
    case "tray":
      cancelSearch();
      return true;
    case "pressMenu":
      dismissPress();
      return true;
    case "reader":
      closeReader();
      return true;
    case "menuSubpage":
      closeMenuSubpage();
      return true;
    case "menu":
      closePageMenu();
      return true;
    case "find":
      closeFind();
      return true;
    case "pageHistory":
      void pageHandle(id)?.goBack();
      return true;
    case "deck":
      void showDeck();
      return true;
    default:
      return false;
  }
}

function closePageLayers() {
  afterMenu = null;
  opening = null;
  cancelTranslationAsk();
  const ui = pageUi();
  if (ui.menuOpen || ui.findOpen || ui.readerTabId || ui.press) {
    if (ui.findOpen) closeFind();
    usePageUi.setState({ menuOpen: false, readerTabId: null, press: null });
  }
  if (canSummarizePages()) quietly(() => pages.dismissSummaries());
}

useBrowse.subscribe((browse, previous) => {
  if (browse.surface !== previous.surface) closePageLayers();
});

let systemFindTab: string | null = null;

function leaveSystemFind() {
  const id = systemFindTab;
  systemFindTab = null;
  if (id) quietly(() => pages.endFind(id));
}

useTabs.subscribe((tabs, previous) => {
  if (tabs.selectedId === previous.selectedId) return;
  if (systemFindTab !== null && systemFindTab !== tabs.selectedId) leaveSystemFind();
  closePageLayers();
});

usePages.subscribe((pagesNow, pagesBefore) => {
  const id = selectedId();
  if (!id) return;
  const navigation = pagesNow.navigation[id];
  const before = pagesBefore.navigation[id];
  if (!navigation || navigation === before || navigation.isLoading) return;
  followOpenMenuHost();
  preparePageMenu();
  if (!before || before.isLoading || before.url !== navigation.url) prepareSearch();
});

useLibrary.subscribe((library, before) => {
  const ui = pageUi();
  if (before.open && !library.open && ui.menuOpen && ui.menuPage === "library") closePageMenu();
});

usePageUi.subscribe((ui, before) => {
  if (before.menuOpen && !ui.menuOpen && ui.menuPage === "library" && useLibrary.getState().open) closeLibrary();
});
