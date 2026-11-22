import { copy } from "../../lib/platformCopy";
import { mobileClean } from "@ardia/core/src/mobile";
import { hostOf } from "@ardia/core/src/omnibox";
import { copyText, pressHaptic, shareLink, successHaptic } from "../../platform/system";
import { settled } from "../pages/store";
import type { TrayRow } from "../search/omnibox";
import { closeTabById, currentTabs, deleteArchivedTabsById, setIncognito, useTabs } from "../tabs/store";
import { isSyncableUrl, type BrowserTab } from "../tabs/tabModels";
import { recentOtherTabs, tabMenuTitle } from "../tabs/tabsState";
import { showToast } from "../toasts/store";
import { openPage, openTab, reopenArchived } from "./store";
import { t } from "../../lib/uiLanguage";


export type RowAction = { label: string; icon: "eyes" | "squareOnSquare" | "link" | "squareAndArrowUp" | "docOnDoc"; run: () => void };

function openSwitchingMode(url: string, origin: "search" | "typed") {
  setIncognito(!useTabs.getState().incognito);
  openPage(url, origin);
}

export function trayRowActions(row: TrayRow): RowAction[] {
  const incognito = useTabs.getState().incognito;
  const icon = incognito ? "squareOnSquare" : "eyes";
  if (row.kind === "query") {
    return [{ label: incognito ? t(`Search in New Tab`) : t(`Search in Incognito Tab`), icon, run: () => openSwitchingMode(row.url, "search") }];
  }
  if (row.kind === "calc") return [{ label: t(`Copy`), icon: "docOnDoc", run: () => quietly(() => copyText(row.value)) }];
  if (row.kind === "paste" || row.kind === "browseForMe") return [];
  return [
    { label: incognito ? t(`Open in New Tab`) : t(`Open in Incognito Tab`), icon, run: () => openSwitchingMode(row.url, "typed") },
    { label: t(`Copy Link`), icon: "link", run: () => copyLink(row.url) },
    { label: t(`Share`), icon: "squareAndArrowUp", run: () => quietly(() => shareLink(row.url, row.title)) },
  ];
}

export function copyLink(url: string) {
  quietly(() => copyText(mobileClean(url)));
  quietly(successHaptic);
  showToast(COPIED_LINK, "link");
}

export const COPIED_LINK = t(`Copied URL Without Trackers`);

const quietly = (call: () => Promise<unknown>) => void settled(call, undefined);

export const canShareTab = (tab: BrowserTab) => isSyncableUrl(tab.url);

export const tabTitle = (tab: BrowserTab) => tabMenuTitle(tab, hostOf(tab.url), copy().untitledTabByAddress);

export function copyTabLink(tab: BrowserTab) {
  if (canShareTab(tab)) copyLink(tab.url);
}

export function shareTab(tab: BrowserTab) {
  if (!canShareTab(tab)) return;
  quietly(() => shareLink(tab.url, tab.title));
}

export const menuOpenedHaptic = () => quietly(pressHaptic);

export const recentTabs = (order: readonly BrowserTab[]) => recentOtherTabs(order);

export const switchToTab = (id: string) => openTab(id);

export function closeFrontTab() {
  const id = currentTabs().selectedId;
  if (id) closeTabById(id);
}

export const openArchivedTab = (tab: BrowserTab) => reopenArchived(tab);

export const deleteArchivedTab = (tab: BrowserTab) => deleteArchivedTabsById([tab.id]);

export const shareUrl = (url: string, title: string) => quietly(() => shareLink(url, title));
