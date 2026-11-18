import { create } from "zustand";
import { getHiddenElements, hideElements, restoreElements } from "../../platform/contentBlocker";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { tabEngine } from "../engines/engines";
import { webviews } from "../tabs/webviewHandles";
import { togglePopover } from "../tabs/popoverDismiss";
import { closeReader, readerState } from "../reader/reader";
import { isSleeping } from "../tabs/sleepingTabs";
import { pickerCall } from "./elementPicker";
import {
  noteElementHidden,
  noteElementPickerCancelled,
  noteElementPickerFromContextMenu,
  noteHiddenElementsRestored,
  noteHiddenElementWriteFailure,
} from "../telemetry/hiddenElementCounts";

const HIDING_RULE = /^[a-z0-9.-]+##[^+^\s][^\n{}]*$/;
const MAX_FILTER = 1024;

export type HiddenElement = { filter: string; host: string; selector: string; session: boolean };
type PickResult = { selector?: string; cancelled?: boolean } | null;

export function hidingHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9.-]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

export function hidingFilter(host: string, selector: string): string | null {
  const filter = `${host}##${selector.trim()}`;
  return filter.length <= MAX_FILTER && HIDING_RULE.test(filter) ? filter : null;
}

export function parseHidingFilter(filter: string, session = false): HiddenElement | null {
  if (!HIDING_RULE.test(filter)) return null;
  const at = filter.indexOf("##");
  return { filter, host: filter.slice(0, at), selector: filter.slice(at + 2), session };
}

export const coversHost = (ruleHost: string, host: string) => host === ruleHost || host.endsWith(`.${ruleHost}`);

export function hiddenElementTitle(selector: string): string {
  const last = selector.split(/\s*>\s*|\s+/).pop() ?? selector;
  return last.replace(/:nth-of-type\((\d+)\)/, " #$1").replace(/\\/g, "") || selector;
}

export const useHiddenElements = create<{ session: Record<string, string[]>; changes: number }>()(() => ({ session: {}, changes: 0 }));

const changed = () => useHiddenElements.setState((s) => ({ changes: s.changes + 1 }));

const privateWindowOf = (profile: string) => (isIncognitoProfile(profile) ? profile.slice("incognito:".length, profile.indexOf("@")) : null);

export function startHiddenElements() {
  return useBrowser.subscribe((s, prev) => {
    if (s.windows === prev.windows) return;
    const session = useHiddenElements.getState().session;
    const kept = Object.entries(session).filter(([profile]) => {
      const windowId = privateWindowOf(profile);
      return !windowId || !!s.windows[windowId];
    });
    if (kept.length !== Object.keys(session).length) useHiddenElements.setState({ session: Object.fromEntries(kept) });
  });
}

const store = () => useBrowser.getState();

function pageOf(tabId: string) {
  const s = store();
  const tab = s.tabs[tabId];
  const host = hidingHost(tab?.url);
  if (!tab || !host || tabEngine(s, tabId) === "webkit") return null;
  return { tab, host, profile: engineProfile(s, tab.profileId), inPrivateWindow: isIncognitoProfile(tab.profileId) };
}

export const canHideElements = (s: BrowserState, tabId: string) => !!hidingHost(s.tabs[tabId]?.url) && tabEngine(s, tabId) !== "webkit";

export async function profileHiddenElements(profile: string): Promise<HiddenElement[]> {
  const filters = await getHiddenElements(profile);
  return filters.map((f) => parseHidingFilter(f)).filter((e): e is HiddenElement => !!e);
}

export async function hiddenElementsOn(tabId: string): Promise<{ host: string; elements: HiddenElement[] } | null> {
  const page = pageOf(tabId);
  if (!page) return null;
  const session = (useHiddenElements.getState().session[page.profile] ?? []).map((f) => parseHidingFilter(f, true));
  const kept = await profileHiddenElements(page.profile).catch((): HiddenElement[] => []);
  const elements = [...kept, ...session].filter((e): e is HiddenElement => !!e && coversHost(e.host, page.host));
  return { host: page.host, elements };
}

export function runHidingCommand(command: string, tabId: string): boolean {
  if (command === "hideElement") void startHidingElement(tabId);
  else if (command === "showHiddenElements") togglePopover(tabId, "hiddenElements");
  else return false;
  return true;
}

const picking = new Set<string>();

export const isPickingElement = (tabId: string) => picking.has(tabId);

export async function startHidingElement(tabId: string, point: [number, number] | null = null) {
  const page = pageOf(tabId);
  const web = webviews.get(tabId);
  if (!page || !web) return;
  if (picking.has(tabId)) {
    void web.evaluate(pickerCall("cancel"));
    return;
  }
  if (point) noteElementPickerFromContextMenu();
  if (readerState(tabId).active) await closeReader(tabId);
  picking.add(tabId);
  let result: PickResult = null;
  try {
    void web.focus();
    result = await web.evaluate<PickResult>(pickerCall("start", point));
  } catch {
    result = null;
  } finally {
    picking.delete(tabId);
  }
  const after = pageOf(tabId);
  const samePage = after?.host === page.host && after.profile === page.profile;
  const filter = samePage && result?.selector ? hidingFilter(page.host, result.selector) : null;
  if (!filter) return void noteElementPickerCancelled();
  noteElementHidden(page.inPrivateWindow);
  if (page.inPrivateWindow) {
    useHiddenElements.setState((s) => {
      const kept = s.session[page.profile] ?? [];
      return { session: { ...s.session, [page.profile]: kept.includes(filter) ? kept : [...kept, filter] } };
    });
    return changed();
  }
  try {
    await hideElements(page.profile, [filter]);
  } catch {
    noteHiddenElementWriteFailure();
  }
  changed();
}

function unhideInOpenTabs(profile: string, elements: HiddenElement[]) {
  const s = store();
  for (const tab of Object.values(s.tabs)) {
    const host = hidingHost(tab.url);
    if (!host || engineProfile(s, tab.profileId) !== profile) continue;
    const selectors = elements.filter((e) => coversHost(e.host, host)).map((e) => e.selector);
    if (selectors.length) void webviews.get(tab.id)?.evaluate(pickerCall("unhide", selectors));
  }
}

const savedProfileOf = (profile: string) => (isIncognitoProfile(profile) ? profile.slice(profile.indexOf("@") + 1) : profile);

function reloadCoveredTabs(profile: string, restored: HiddenElement[]) {
  const s = store();
  const saved = savedProfileOf(profile);
  for (const [tabId, tab] of Object.entries(s.tabs)) {
    const host = hidingHost(tab.url);
    const sameProfile = savedProfileOf(engineProfile(s, tab.profileId)) === saved;
    if (host && sameProfile && !isSleeping(tabId) && restored.some((e) => coversHost(e.host, host))) void webviews.get(tabId)?.reload();
  }
}

export async function restoreHiddenElements(profile: string, elements: HiddenElement[]) {
  const session = new Set(elements.filter((e) => e.session).map((e) => e.filter));
  const kept = elements.filter((e) => !e.session).map((e) => e.filter);
  if (session.size)
    useHiddenElements.setState((s) => ({ session: { ...s.session, [profile]: (s.session[profile] ?? []).filter((f) => !session.has(f)) } }));
  unhideInOpenTabs(profile, elements);
  try {
    if (kept.length) await restoreElements(profile, kept);
    noteHiddenElementsRestored(elements.length);
  } catch {
    noteHiddenElementWriteFailure();
  }
  changed();
  if (kept.length) reloadCoveredTabs(profile, elements.filter((e) => !e.session));
}

const sessionHidingKey = (s: BrowserState, tabId: string) => {
  const tab = s.tabs[tabId];
  return tab && isIncognitoProfile(tab.profileId) ? `${tab.url}\n${s.live[tabId]?.isLoading ? 1 : 0}` : null;
};

useBrowser.subscribe((s, prev) => {
  const session = useHiddenElements.getState().session;
  if (!Object.keys(session).length || (s.tabs === prev.tabs && s.live === prev.live)) return;
  for (const tabId of Object.keys(s.tabs)) {
    const key = sessionHidingKey(s, tabId);
    if (!key || key === sessionHidingKey(prev, tabId)) continue;
    const tab = s.tabs[tabId]!;
    const host = hidingHost(tab.url);
    const filters = session[engineProfile(s, tab.profileId)] ?? [];
    const selectors = filters.map((f) => parseHidingFilter(f)).filter((e): e is HiddenElement => !!e && !!host && coversHost(e.host, host)).map((e) => e.selector);
    if (selectors.length) void webviews.get(tabId)?.evaluate(pickerCall("apply", selectors));
  }
});
