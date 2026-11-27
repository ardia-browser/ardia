import { addHistoryVisits } from "../../platform/history";
import { useBrowser } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";

const SETTLE_MS = 1200;
type Visit = { url: string; title: string; at: number; timer: ReturnType<typeof setTimeout> | null };
const open = new Map<string, Visit>();
const written = new Map<string, string>();

function write(tabId: string, visit: Visit) {
  if (visit.timer) clearTimeout(visit.timer);
  visit.timer = null;
  if (open.get(tabId) === visit) open.delete(tabId);
  if (written.size > 500) written.clear();
  written.set(tabId, visit.url);
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  if (!tab || isIncognitoProfile(tab.profileId)) return;
  void addHistoryVisits(engineProfile(s, tab.profileId), [{ url: visit.url, title: visit.title, visitTimes: [visit.at] }]).catch(() => {});
}

export function notePluginPageVisit(tabId: string, url: string, title: string, now = Date.now()) {
  let visit = open.get(tabId);
  if (visit && visit.url !== url) {
    write(tabId, visit);
    visit = undefined;
  }
  if (!visit) {
    if (written.get(tabId) === url) return;
    visit = { url, title, at: now, timer: null };
    open.set(tabId, visit);
  } else if (title) visit.title = title;
  if (visit.timer) clearTimeout(visit.timer);
  const settling = visit;
  settling.timer = setTimeout(() => write(tabId, settling), title ? SETTLE_MS / 4 : SETTLE_MS);
}

export function endPluginPageVisit(tabId: string) {
  const visit = open.get(tabId);
  if (visit) write(tabId, visit);
}

export function replacePluginPageVisit(tabId: string, from: string, to: string) {
  if (from === to) return;
  const visit = open.get(tabId);
  if (visit && visit.url === from) {
    visit.url = to;
    visit.title = "";
    return;
  }
  if (written.get(tabId) === from) written.delete(tabId);
}
