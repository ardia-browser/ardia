import type { WebViewHandle } from "@ardia/ardiacore";

export const webviews = new Map<string, WebViewHandle>();

const mounts = new Map<string, object>();
const changeListeners = new Set<() => void>();

export function onWebviewsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => void changeListeners.delete(listener);
}

const webviewsChanged = () => {
  for (const listener of changeListeners) listener();
};

export const webviewMount = (tabId: string) => mounts.get(tabId);

export function webviewRef(tabId: string) {
  let mine: WebViewHandle | null = null;
  const mount = {};
  return (handle: WebViewHandle | null) => {
    if (handle) {
      mine = handle;
      webviews.set(tabId, handle);
      mounts.set(tabId, mount);
      webviewsChanged();
    } else if (mine && webviews.get(tabId) === mine) {
      webviews.delete(tabId);
      mounts.delete(tabId);
      webviewsChanged();
    }
  };
}
