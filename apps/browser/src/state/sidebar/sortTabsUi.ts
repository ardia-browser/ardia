import type { MenuItem } from "../../platform/menus";
import { useBrowser, type BrowserState } from "../browser/store";
import { plural } from "../browser/model";
import { menuShortcut } from "../commands/commandShortcuts";
import { canSort, canUndoSort, SORT_KEYS, sorting, unsorting, type Sorted, type SortKey, type SortTarget } from "./sortTabs";
import { showUndoToast } from "./undoToast";

const SORT_TITLES: Record<SortKey, string> = { site: "By Site", title: "By Title" };
const SORT_SYMBOLS: Record<SortKey, string> = { site: "globe", title: "textformat" };

export const SORT_MENU_ID = "sortTabs";

const sortChoice = (key: SortKey) => `${SORT_MENU_ID}:${key}`;

export function sortTabsMenuItem(s: BrowserState, target: SortTarget, hints = false): Extract<MenuItem, { id: string }> {
  const children = SORT_KEYS.map((key) => ({
    id: sortChoice(key),
    title: SORT_TITLES[key],
    symbol: SORT_SYMBOLS[key],
    enabled: canSort(s, target, key),
    ...(hints ? menuShortcut(sortChoice(key), s) : {}),
  }));
  return { id: SORT_MENU_ID, title: "Sort Tabs", symbol: "arrow.up.arrow.down", enabled: children.some((c) => c.enabled), children };
}

export function sortKeyOfChoice(choice: string): SortKey | null {
  return SORT_KEYS.find((key) => choice === sortChoice(key)) ?? null;
}

export function sortTabs(target: SortTarget, key: SortKey): boolean {
  let sorted: Sorted | null = null;
  useBrowser.setState((s) => {
    const [next, done] = sorting(s, target, key);
    sorted = done;
    return next;
  });
  const done = sorted as Sorted | null;
  if (!done) return false;
  showUndoToast(target.windowId, `Sorted ${plural(done.tabs, "Tab")}`, "arrow.up.arrow.down", {
    undo: () => useBrowser.setState((s) => unsorting(s, done)),
    watched: (s) => [s.windows, s.groups, s.splits, s.tabs, s.settings],
    canUndo: (s) => canUndoSort(s, done),
  });
  return true;
}
