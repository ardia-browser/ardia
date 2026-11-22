import { confirm } from "../../platform/dialogs";
import { showMenu, type MenuItem } from "../../platform/menus";
import { menuSections } from "../app/menuSections";
import { copyLinkItems, openAllItems, openLinkItems, runLinkChoice, type Link } from "../bookmarks/linkMenus";
import { t } from "../../lib/uiLanguage";


export async function confirmRemoveSelected(windowId: string): Promise<boolean> {
  const { confirmed } = await confirm({
    title: t(`Remove selected items?`),
    message: t(`Are you sure you want to delete these pages from your history?`),
    confirmTitle: t(`Remove`),
    destructive: true,
    windowId,
  });
  return confirmed;
}

export function historyRowMenuItems(count: number): MenuItem[] {
  if (count > 1)
    return menuSections(openAllItems(count, count), copyLinkItems(count), [{ id: "remove", title: `Remove ${count} Pages from History…`, symbol: "trash" }]);
  return menuSections(
    openLinkItems(),
    [...copyLinkItems(), { id: "more", title: t(`More from This Site`), symbol: "magnifyingglass" }],
    [{ id: "remove", title: t(`Remove from History`), symbol: "trash" }],
  );
}

export async function openHistoryRowMenu(entries: Link[], windowId: string, onMoreFromSite: (url: string) => void, onRemove: (urls: string[]) => void) {
  if (!entries.length) return;
  const choice = await showMenu(historyRowMenuItems(entries.length));
  if (runLinkChoice(choice, entries, windowId)) return;
  if (choice === "more") onMoreFromSite(entries[0]!.url);
  if (choice === "remove") {
    if (entries.length > 1 && !(await confirmRemoveSelected(windowId))) return;
    onRemove(entries.map((e) => e.url));
  }
}

export function shownSelection(selected: Set<string>, rows: { entry: { url: string } }[]): Set<string> {
  if (!selected.size) return selected;
  const shown = new Set(rows.map((r) => r.entry.url));
  const kept = [...selected].filter((url) => shown.has(url));
  return kept.length === selected.size ? selected : new Set(kept);
}
