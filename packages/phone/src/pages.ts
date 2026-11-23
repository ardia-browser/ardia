import { requireNativeModule } from "expo-modules-core";
import { normalizeState } from "./normalize";
import type {
  NightShade,
  NightShadeMode,
  PageEngineCapabilities,
  PageEngineEvent,
  PageRequestAnswer,
  PageSetup,
  PageSnapshot,
  RefusedSnapshot,
  PageSummaryProvider,
  PageScrollPosition,
  PageState,
  PageToneInsets,
  ReadableContent,
  Subscription,
  WebsiteDataKind,
} from "./pageTypes";

const NOT_READY: PageEngineCapabilities = {
  ready: false,
  engineName: "not ready",
  isDevelopmentOnly: true,
  supportsPrivatePages: false,
  pageZoomLevels: [],
  pageZoomScalesTextOnly: true,
  snapshotsIncludeVideo: false,
};

export type LaunchArgumentValue = string | number | boolean;

export type LaunchOptions = { pageLab: boolean; syncDemo: boolean; lab: boolean; arguments: Record<string, LaunchArgumentValue> };

export type AppRelease = { releaseVersion: string; build: string; receiptName: string | null };

export type OffscreenCapture = { fileName: string; path: string; title: string | null; themeColorHex: string | null };


export type SitePermissionKind = "camera" | "microphone" | "location";

export type PageTranslationState = { language: string | null; languageName: string | null; confirmed: boolean };

export type SitePermissionGrant = { origin: string; host: string; permissions: SitePermissionKind[]; grantedAt: number };

type PagesNative = {
  remembersSitePermissions?: boolean;
  sitePermissions?(): Promise<SitePermissionGrant[]>;
  revokeSitePermission?(origin: string, permission: SitePermissionKind | null): Promise<boolean>;
  addListener(eventName: "onPageEngineEvent", listener: (event: PageEngineEvent) => void): Subscription;
  capabilities(): PageEngineCapabilities;
  launchOptions(): { pageLab: boolean; syncDemo?: boolean; lab?: boolean; arguments?: Record<string, LaunchArgumentValue> } | null;
  appRelease?(): AppRelease | null;
  captureOffscreen?(url: string, pageId: string): Promise<OffscreenCapture | null>;
  openPage(pageId: string, setup: PageSetup): Promise<void>;
  closePage(pageId: string): Promise<void>;
  pageIds(): Promise<string[]>;
  pageState(pageId: string): Promise<PageState | null>;
  load(pageId: string, url: string): Promise<void>;
  reload(pageId: string): Promise<void>;
  stopLoading(pageId: string): Promise<void>;
  goBack(pageId: string): Promise<boolean>;
  goForward(pageId: string): Promise<boolean>;
  find(pageId: string, text: string): Promise<void>;
  findNext(pageId: string): Promise<void>;
  findPrevious(pageId: string): Promise<void>;
  endFind(pageId: string): Promise<void>;
  setPageZoom(pageId: string, zoom: number): Promise<number>;
  zoomIn(pageId: string): Promise<number>;
  zoomOut(pageId: string): Promise<number>;
  setDesktopSite(pageId: string, enabled: boolean): Promise<void>;
  download(pageId: string, url: string): Promise<void>;
  readableContent(pageId: string): Promise<ReadableContent | null>;
  print?(pageId: string): Promise<boolean>;
  sharePage?(pageId: string, url: string, title: string): Promise<string | null>;
  summarizePage?(pageId: string): Promise<boolean>;
  dismissPageSummaries?(): Promise<void>;
  pageSummariesEnabled?(): Promise<boolean>;
  setPageSummariesEnabled?(enabled: boolean): Promise<boolean>;
  pageSummaryProvider?(): Promise<string>;
  setPageSummaryProvider?(provider: PageSummaryProvider): Promise<string>;
  translation?(): Promise<PageTranslationState>;
  translationUrl?(pageUrl: string): Promise<string | null>;
  confirmTranslation?(): Promise<void>;
  presentSystemFind?(pageId: string, text: string | null): Promise<boolean>;
  snapshot(pageId: string, options: { maxWidth?: number; quality?: number; coveredInsets?: [number, number]; windowCopy?: boolean; quiet?: boolean }): Promise<PageSnapshot | RefusedSnapshot | null>;
  loadHtml(pageId: string, html: string, baseUrl: string): Promise<void>;
  scrollPosition(pageId: string): Promise<PageScrollPosition | null>;
  evaluate(pageId: string, script: string): Promise<string | null>;
  discardBackgroundPages(keeping: string | null): Promise<void>;
  livePageIds(): Promise<string[]>;
  deleteSnapshots(pageId: string): Promise<void>;
  deleteSnapshotsFor?(pageIds: string[]): Promise<void>;
  snapshotIsCurrent?(pageId: string): boolean | null;
  snapshotsCommitted?(entries: Record<string, string>): void;
  saveState(pageId: string): Promise<string | null>;
  answerRequest(pageId: string, requestId: string, answer: PageRequestAnswer): Promise<boolean>;
  openPopup(pageId: string, popupId: string): Promise<boolean>;
  dismissPopup(popupId: string): Promise<boolean>;
  exitFullscreen(pageId: string): Promise<void>;
  endPrivateSession(): Promise<void>;
  nightShade(host?: string | null, isPrivate?: boolean): Promise<NightShade>;
  setNightShade(mode: NightShadeMode | null, host?: string | null, isPrivate?: boolean): Promise<void>;
  forgetNightShadeVerdicts?(since: number | null): Promise<void>;
  opensLinksInApps(host: string): Promise<boolean>;
  setOpensLinksInApps(host: string, opens: boolean | null): Promise<void>;
  siteOpensLinksInApps?(host: string): Promise<boolean | null>;
  appLinksDefault?(): Promise<boolean>;
  setAppLinksDefault?(opens: boolean): Promise<void>;
  clearWebsiteData(kinds: WebsiteDataKind[]): Promise<void>;
  clearWebsiteDataSince?(kinds: WebsiteDataKind[], since: number): Promise<void>;
  setInspectable(inspectable: boolean): Promise<void>;
};

let loaded: PagesNative | undefined;
const native = () => (loaded ??= requireNativeModule<PagesNative>("ArdiaPhonePageView"));

export const pages = {
  capabilities: (): PageEngineCapabilities => {
    try {
      const capabilities = native().capabilities();
      return { ...capabilities, ready: capabilities.ready ?? true };
    } catch (error) {
      return { ...NOT_READY, engineName: `not ready: ${error instanceof Error ? error.message : "refused"}` };
    }
  },
  captureOffscreen: async (url: string, pageId: string): Promise<OffscreenCapture | null> => {
    try {
      return (await native().captureOffscreen?.(url, pageId)) ?? null;
    } catch {
      return null;
    }
  },
  appRelease: (): AppRelease | null => {
    try {
      return native().appRelease?.() ?? null;
    } catch {
      return null;
    }
  },
  launchOptions: (): LaunchOptions | null => {
    const options = native().launchOptions();
    return options ? { pageLab: options.pageLab, syncDemo: options.syncDemo ?? false, lab: options.lab ?? false, arguments: options.arguments ?? {} } : null;
  },
  open: (pageId: string, setup: PageSetup = {}) => native().openPage(pageId, setup),
  close: (pageId: string) => native().closePage(pageId),
  ids: () => native().pageIds(),
  state: async (pageId: string) => {
    const state = await native().pageState(pageId);
    return state ? normalizeState(state, false) : null;
  },
  load: (pageId: string, url: string) => native().load(pageId, url),
  reload: (pageId: string) => native().reload(pageId),
  stopLoading: (pageId: string) => native().stopLoading(pageId),
  goBack: (pageId: string) => native().goBack(pageId),
  goForward: (pageId: string) => native().goForward(pageId),
  find: (pageId: string, text: string) => native().find(pageId, text),
  findNext: (pageId: string) => native().findNext(pageId),
  findPrevious: (pageId: string) => native().findPrevious(pageId),
  endFind: (pageId: string) => native().endFind(pageId),
  setPageZoom: (pageId: string, zoom: number) => native().setPageZoom(pageId, zoom),
  zoomIn: (pageId: string) => native().zoomIn(pageId),
  zoomOut: (pageId: string) => native().zoomOut(pageId),
  setDesktopSite: (pageId: string, enabled: boolean) => native().setDesktopSite(pageId, enabled),
  download: (pageId: string, url: string) => native().download(pageId, url),
  readableContent: (pageId: string) => native().readableContent(pageId),
  listsSitePermissions: (): boolean => typeof native().sitePermissions === "function",
  remembersSitePermissions: (): boolean => native().remembersSitePermissions === true,
  sitePermissions: (): Promise<SitePermissionGrant[]> => native().sitePermissions?.() ?? Promise.resolve([]),
  revokeSitePermission: (origin: string, permission?: SitePermissionKind): Promise<boolean> =>
    native().revokeSitePermission?.(origin, permission ?? null) ?? Promise.resolve(false),
  print: (pageId: string): Promise<boolean> => native().print?.(pageId) ?? Promise.resolve(false),
  canPrint: (): boolean => typeof native().print === "function",
  sharePage: (pageId: string, url: string, title: string): Promise<string | null> => native().sharePage?.(pageId, url, title) ?? Promise.resolve(null),
  sharesWithPrint: (): boolean => typeof native().sharePage === "function",
  summarize: (pageId: string): Promise<boolean> => native().summarizePage?.(pageId) ?? Promise.resolve(false),
  canSummarize: (): boolean => typeof native().summarizePage === "function",
  dismissSummaries: (): Promise<void> => native().dismissPageSummaries?.() ?? Promise.resolve(),
  switchesSummaries: (): boolean => typeof native().setPageSummariesEnabled === "function",
  summariesEnabled: async (): Promise<boolean> => (await native().pageSummariesEnabled?.()) === true,
  setSummariesEnabled: async (enabled: boolean): Promise<boolean> => (await native().setPageSummariesEnabled?.(enabled)) === true,
  choosesSummaryProvider: (): boolean => typeof native().setPageSummaryProvider === "function",
  summaryProvider: async (): Promise<PageSummaryProvider> => ((await native().pageSummaryProvider?.()) === "chatgpt" ? "chatgpt" : "on_device"),
  setSummaryProvider: async (provider: PageSummaryProvider): Promise<PageSummaryProvider> => ((await native().setPageSummaryProvider?.(provider)) === "chatgpt" ? "chatgpt" : "on_device"),
  translation: (): Promise<PageTranslationState | null> => native().translation?.() ?? Promise.resolve(null),
  translationUrl: (pageUrl: string): Promise<string | null> => native().translationUrl?.(pageUrl) ?? Promise.resolve(null),
  confirmTranslation: (): Promise<void> => native().confirmTranslation?.() ?? Promise.resolve(),
  hasSystemFind: (): boolean => typeof native().presentSystemFind === "function",
  presentSystemFind: (pageId: string, text?: string): Promise<boolean> => native().presentSystemFind?.(pageId, text ?? null) ?? Promise.resolve(false),
  snapshot: (pageId: string, options: { maxWidth?: number; quality?: number; coveredInsets?: PageToneInsets; windowCopy?: boolean; quiet?: boolean } = {}) =>
    native().snapshot(pageId, {
      maxWidth: options.maxWidth,
      quality: options.quality,
      coveredInsets: options.coveredInsets ? [options.coveredInsets.top, options.coveredInsets.bottom] : undefined,
      windowCopy: options.windowCopy,
      ...(options.quiet ? { quiet: true } : {}),
    }),
  loadHtml: (pageId: string, html: string, baseUrl: string) => native().loadHtml(pageId, html, baseUrl),
  scrollPosition: (pageId: string) => native().scrollPosition(pageId),
  evaluate: (pageId: string, script: string) => native().evaluate(pageId, script),
  discardBackgroundPages: (keeping?: string | null) => native().discardBackgroundPages(keeping ?? null),
  livePageIds: () => native().livePageIds(),
  deleteSnapshots: (pageId: string) => native().deleteSnapshots(pageId),
  deletesSnapshotsTogether: (): boolean => typeof native().deleteSnapshotsFor === "function",
  deleteSnapshotsFor: (pageIds: string[]) => native().deleteSnapshotsFor!(pageIds),
  snapshotIsCurrent: (pageId: string): boolean | null => native().snapshotIsCurrent?.(pageId) ?? null,
  snapshotsCommitted: (entries: Record<string, string>): void => native().snapshotsCommitted?.(entries),
  saveState: (pageId: string) => native().saveState(pageId),
  answerRequest: (pageId: string, requestId: string, answer: PageRequestAnswer) => native().answerRequest(pageId, requestId, answer),
  openPopup: (pageId: string, popupId: string) => native().openPopup(pageId, popupId),
  dismissPopup: (popupId: string) => native().dismissPopup(popupId),
  exitFullscreen: (pageId: string) => native().exitFullscreen(pageId),
  endPrivateSession: () => native().endPrivateSession(),
  nightShade: (host?: string | null, isPrivate = false) => native().nightShade(host ?? null, isPrivate),
  setNightShade: (mode: NightShadeMode | null, host?: string | null, isPrivate = false) => native().setNightShade(mode, host ?? null, isPrivate),
  forgetNightShadeVerdicts: async (since: number | null): Promise<void> => {
    await native().forgetNightShadeVerdicts?.(since);
  },
  opensLinksInApps: (host: string) => native().opensLinksInApps(host),
  setOpensLinksInApps: (host: string, opens: boolean | null) => native().setOpensLinksInApps(host, opens),
  siteOpensLinksInApps: async (host: string): Promise<boolean | null> => (await native().siteOpensLinksInApps?.(host)) ?? null,
  appLinksDefault: async (): Promise<boolean> => (await native().appLinksDefault?.()) ?? false,
  setAppLinksDefault: async (opens: boolean): Promise<void> => {
    await native().setAppLinksDefault?.(opens);
  },
  clearWebsiteData: (kinds: WebsiteDataKind[], since?: number | null): Promise<void> => {
    const bounded = native().clearWebsiteDataSince;
    return since != null && bounded ? bounded(kinds, since) : native().clearWebsiteData(kinds);
  },
  clearsWebsiteDataSince: (): boolean => typeof native().clearWebsiteDataSince === "function",
  setInspectable: (inspectable: boolean) => native().setInspectable(inspectable),
  addListener: (listener: (event: PageEngineEvent) => void): Subscription =>
    native().addListener("onPageEngineEvent", (event) =>
      listener(event.name === "page.state" ? { ...event, state: normalizeState(event.state, false) } : event),
    ),
};
