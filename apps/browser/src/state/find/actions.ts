import { webviews } from "../../platform/webviews";
import { useBrowser } from "../browser/store";
import { noteFind } from "../telemetry/findCounts";
import { setFind } from "../windows/actions";

export { noteFind };

const SUBMIT_AFTER_KEY_MS = 250;

export const submitRepeatsKey = (keyAt: number, now: number) => now - keyAt < SUBMIT_AFTER_KEY_MS;

const barOpen = (tabId: string) => !!useBrowser.getState().find[tabId]?.open;

export function openFind(tabId: string, options: { replace?: boolean; query?: string } = {}) {
  if (!barOpen(tabId)) noteFind("opened");
  setFind(tabId, { open: true, ...options, focusRequest: Date.now() });
}

export function closeFind(tabId: string, { refocus = true }: { refocus?: boolean } = {}) {
  setFind(tabId, { open: false, count: null, active: 0 });
  void webviews.get(tabId)?.stopFinding(false);
  if (refocus) void webviews.get(tabId)?.focus();
}

export function findStep(tabId: string, backwards: boolean) {
  const query = useBrowser.getState().find[tabId]?.query;
  if (!query) {
    if (!barOpen(tabId)) noteFind("opened");
    return setFind(tabId, { open: true });
  }
  noteFind("stepped");
  void webviews.get(tabId)?.find(query, !backwards, true);
}

export const takeFindFocusRequest = (tabId: string) => setFind(tabId, { focusRequest: undefined });
