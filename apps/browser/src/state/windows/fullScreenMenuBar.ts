const menuBarShownWindows = new Set<string>();
const menuBarWatchers = new Map<string, Set<() => void>>();

export const menuBarShownIn = (windowId: string): boolean => menuBarShownWindows.has(windowId);

export function setMenuBarShown(windowId: string, shown: boolean): boolean {
  if (menuBarShownWindows.has(windowId) === shown) return false;
  if (shown) menuBarShownWindows.add(windowId);
  else menuBarShownWindows.delete(windowId);
  for (const watcher of [...(menuBarWatchers.get(windowId) ?? [])]) watcher();
  return true;
}

export function onMenuBarChange(windowId: string, listener: () => void): () => void {
  let watchers = menuBarWatchers.get(windowId);
  if (!watchers) menuBarWatchers.set(windowId, (watchers = new Set()));
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
    if (!watchers.size && menuBarWatchers.get(windowId) === watchers) menuBarWatchers.delete(windowId);
  };
}
