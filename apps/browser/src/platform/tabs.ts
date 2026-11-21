import { call, nativeModule, on, type TabStripTransaction, type WindowRequest } from "@ardia/ardiacore";

export {
  sendTabStripCommand,
  type LinkRoute,
  type StripTab,
  type StripGroup,
  type StripState,
  type TabStripCommand,
  type TabStripTransaction,
  type PageEngine,
  type WebViewHandle,
  type NavigationState,
  type BlockedPopup,
  type CrashInfo,
  type MediaAccess,
  type SecurityInfo,
  type AutofillPrompt,
  type AutofillPromptAnswer,
  type PasswordPrompt,
  type PasswordPromptAnswer,
  type OpenWindowRequest,
  type WebNotification,
  type PageSelection,
  type ScrollState,
  type FocusRestoreOutcome,
  type ProtectedMediaRequest,
  type AppBadge,
} from "@ardia/ardiacore";

const Tabs = nativeModule("ArdiaTabs");

export const prepareTabTransfer = (tabId: string) => Tabs.prepareTransfer(tabId);
export const releaseTabTransfer = (tabId: string) => Tabs.releaseTransfer(tabId);
export const claimLaunchTab = (tabId: string, url: string, profile: string) => Tabs.claimLaunchTab(tabId, url, profile);
export const revealTab = (tabId: string, press: number) => Tabs.revealTab(tabId, press);
export const dropTabReveals = (overTabId: string, press: number, toTabId: string) => Tabs.dropTabReveals(overTabId, press, toTabId);
export const claimTabPress = (tabId: string, startedAt: number) => Tabs.claimTabPress(tabId, startedAt);
export const dropTabPress = (press: number) => Tabs.dropTabPress(press);
export const setTabsInSplits = (tabIds: string[]) => Tabs.setTabsInSplits(tabIds);
export const setNativeTabSwitch = (enabled: boolean) => Tabs.setNativeTabSwitch(enabled);
export const revealOffered = (adoptId: string, overTabId: string, press: number) => Tabs.revealOffered(adoptId, overTabId, press);
export const discardOffered = (adoptId: string) => Tabs.discardOffered(adoptId);
export const routeLinkTabs = (urls: string[]) => call("tabs.routeLinkTabs", { urls });

export const onTabStripTransaction = (listener: (tx: TabStripTransaction) => void) => on("tabs.strips", listener);
export const onWindowRequest = (listener: (request: WindowRequest) => void) => on("tabs.windowRequest", listener);
export const tabStrips = () => call("tabs.strips");
export type CommitReader = "automation" | "pageBars";

export const reportPageCommits = (reader: CommitReader, on: boolean) => call("tabs.reportCommits", { reader, on });
export const lastTabClosesWindow = () => call("tabs.lastTabPolicy").then((r) => r.closesWindow);
