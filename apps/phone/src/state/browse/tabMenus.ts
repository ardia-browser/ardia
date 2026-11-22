import { copy } from "../../lib/platformCopy";
import { actionWords } from "../../lib/sharedWords";
import { iconRoleSymbols as iconRoles } from "../../lib/iconRoles";
import { hostOf } from "@ardia/core/src/omnibox";
import { copyText, pressHaptic, shareLink, successHaptic } from "../../platform/system";
import { linkToCopy } from "../page/linkCopy";
import { settled } from "../pages/store";
import type { TrayRow } from "../search/omnibox";
import { closeTabById, currentTabs, deleteArchivedTabsById, setIncognito, useTabs } from "../tabs/store";
import { isSyncableUrl, type BrowserTab } from "../tabs/tabModels";
import { recentOtherTabs, tabMenuTitle } from "../tabs/tabsState";
import { showToast } from "../toasts/store";
import { openPage, openTab, reopenArchived } from "./store";

export type RowAction = { label: string; icon: "eyes" | "squareOnSquare" | typeof iconRoles.copyLink | typeof iconRoles.share | typeof iconRoles.copyText; run: () => void };

function openSwitchingMode(url: string, origin: "search" | "typed") {
  if (!setIncognito(!useTabs.getState().incognito)) return;
  openPage(url, origin);
}

export function trayRowActions(row: TrayRow): RowAction[] {
  const incognito = useTabs.getState().incognito;
  const icon = incognito ? "squareOnSquare" : "eyes";
  if (row.kind === "query") {
    return [{ label: incognito ? "Search in New Tab" : "Search in Incognito Tab", icon, run: () => openSwitchingMode(row.url, "search") }];
  }
  if (row.kind === "calc") return [{ label: actionWords.copyText, icon: iconRoles.copyText, run: () => quietly(() => copyText(row.value)) }];
  if (row.kind === "paste" || row.kind === "browseForMe") return [];
  return [
    { label: incognito ? "Open in New Tab" : "Open in Incognito Tab", icon, run: () => openSwitchingMode(row.url, "typed") },
    { label: actionWords.copyLink, icon: iconRoles.copyLink, run: () => copyLink(row.url) },
    { label: actionWords.share, icon: iconRoles.share, run: () => quietly(() => shareLink(row.url, row.title)) },
  ];
}

export function copyLink(url: string) {
  const link = linkToCopy(url);
  quietly(() => copyText(link.text));
  quietly(successHaptic);
  showToast(link.acknowledgement, iconRoles.copyLink);
}

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
