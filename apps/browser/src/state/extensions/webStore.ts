import { onExtensionInstallPrompt, resolveExtensionInstallPrompt } from "../../platform/extensions";
import { webviews } from "../../platform/webviews";
import { webStoreExtensionId } from "@ardia/core";
import { useBrowser, type BrowserState } from "../browser/store";
import { changedIds } from "../browser/changes";
import { liveOf, onLiveChange } from "../tabs/tabLive";
import { extensionProfile, findExtension, removeExtension, showInstallPrompt } from "./actions";
import { focusedWindowOf } from "../windows/ui";
import { noteExtensionInstallPrompt } from "../telemetry/usage";

const STORE_SCRIPT = `
const g = window;
if (!g.__ardiaStore) {
  const store = (g.__ardiaStore = { waiting: null, queued: [] });
  const request = (id) => {
    if (!id) return;
    if (store.waiting) { const w = store.waiting; store.waiting = null; w(id); } else store.queued.push(id);
  };
  const mg = g.chrome && g.chrome.management;
  if (mg && typeof mg.uninstall === "function") {
    Object.defineProperty(mg, "uninstall", { configurable: true, writable: true, value: (id, options, callback) => {
      request(id);
      const done = typeof options === "function" ? options : callback;
      if (typeof done === "function") { setTimeout(done); return; }
      return Promise.resolve();
    } });
  }
  const relabel = () => {
    for (const el of document.querySelectorAll("button, button *")) {
      if (el.childElementCount) continue;
      const t = el.textContent;
      if (t === "Add to Chrome") el.textContent = "Add to Ardia";
      else if (t === "Remove from Chrome") el.textContent = "Remove from Ardia";
    }
  };
  relabel();
  new MutationObserver(relabel).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
}
const store = g.__ardiaStore;
if (store.queued.length) post("result", JSON.stringify(store.queued.shift()));
else store.waiting = (id) => post("result", JSON.stringify(id));
`;

const isStorePage = (url: string | undefined) => !!url && /^https:\/\/chromewebstore\.google\.com\//.test(url);

export function startWebStoreIntegration() {
  onExtensionInstallPrompt((prompt) => {
    noteExtensionInstallPrompt();
    const s = useBrowser.getState();
    const tabId = prompt.tabId ?? undefined;
    const windowId = (tabId && s.tabs[tabId]?.windowId) || focusedWindowOf(s) || s.windowOrder[0];
    if (windowId) showInstallPrompt(windowId, prompt);
    else void resolveExtensionInstallPrompt(prompt, false);
  });
  const listening = new Map<string, string>();
  const listen = (tabId: string, url: string) => {
    listening.set(tabId, url);
    const web = webviews.get(tabId);
    if (!web) return void listening.delete(tabId);
    void web.evaluate<string>(STORE_SCRIPT).then((id) => {
      const s = useBrowser.getState();
      const tab = s.tabs[tabId];
      if (!tab || listening.get(tabId) !== url) return;
      const profile = extensionProfile(s, tab.windowId);
      const ext = id && webStoreExtensionId(id) ? findExtension(profile, id) : undefined;
      if (ext) void removeExtension(profile, ext, tab.windowId);
      if (tab.url === url) listen(tabId, url);
    });
  };
  const sync = (s: BrowserState, ids: Iterable<string>) => {
    for (const [tabId, url] of listening) if (s.tabs[tabId]?.url !== url || liveOf(tabId).isLoading) listening.delete(tabId);
    for (const id of ids) {
      const tab = s.tabs[id];
      if (!tab || !isStorePage(tab.url) || liveOf(id).isLoading || listening.get(id) === tab.url) continue;
      listen(id, tab.url);
    }
  };
  useBrowser.subscribeTo(["tabs"], (s, prev) => {
    if (s.tabs !== prev.tabs) sync(s, changedIds(s.tabs, prev.tabs));
  });
  onLiveChange((id) => sync(useBrowser.getState(), [id]));
  sync(useBrowser.getState(), Object.keys(useBrowser.getState().tabs));
}
