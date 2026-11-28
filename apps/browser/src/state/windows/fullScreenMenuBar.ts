const menuBarShownWindows = new Set<string>();
const menuBarWatchers = new Set<() => void>();

export const menuBarShownIn = (windowId: string): boolean => menuBarShownWindows.has(windowId);

export function setMenuBarShown(windowId: string, shown: boolean): boolean {
  if (menuBarShownWindows.has(windowId) === shown) return false;
  if (shown) menuBarShownWindows.add(windowId);
  else menuBarShownWindows.delete(windowId);
  for (const watcher of [...menuBarWatchers]) watcher();
  return true;
}

export function onMenuBarChange(listener: () => void): () => void {
  menuBarWatchers.add(listener);
  return () => void menuBarWatchers.delete(listener);
}
