import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { childProcessCpu, listTasks } from "../../platform/performance";
import { everySlowly } from "../../platform/slowTimers";
import { onWebviewsChanged, webviews } from "../../platform/webviews";
import { isQuitting, onQuittingChanged } from "../app/quit";
import { hideKeyedToast, showToast, useToasts } from "../app/toasts";
import { isIncognitoProfile } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";
import { noteBusyTab } from "../telemetry/busyTabCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { focusedWindowOf } from "../windows/ui";
import { BUSY_TICK_MS, HOT_CORES, keptActive, readHeat, siteToKeepActive, SUSTAINED_MS, sustainedBusy, validReadings, type ProcessHeat } from "./busyProcesses";
import { inUse } from "./loadedTabBudget";
import { hasLoadedPage } from "./pageSession";
import { canSleep, sleepAsked } from "./manualSleep";
import { keepSiteActive } from "./memorySaver";
import { shownTabIds } from "./shownTabs";
import { useLifecycle } from "./sleepingTabs";

type Owner = { started: number; at: number; tabIds: string[]; urls: Map<string, string> };

const MINUTE = 60_000;
const OWNERS_FRESH_MS = 5 * MINUTE;
const QUIET_AFTER_WARNING_MS = 120 * MINUTE;
const WARNING_HOLD_MS = 20_000;
const WARNING_TITLE_LINES = 2;
const TOAST_KEY = "busyTab";
const NAME_CHARS = 24;
const ICON = "bolt.fill";

let heat = new Map<number, ProcessHeat>();
const owners = new Map<number, Owner>();
const hiddenSince = new Map<string, number>();
const quietUntil = new Map<string, number>();
const keptTabs = new Set<string>();
let ticking = false;
let unsupported = false;
let generation = 0;
let hotCores = HOT_CORES;
let lastTickAt = 0;

const clock = () => Math.max(Date.now(), lastTickAt);

const hasTab = (s: BrowserState, id: unknown): id is string => typeof id === "string" && Object.hasOwn(s.tabs, id);

const isPrivate = (s: BrowserState, id: string) => {
  const tab = s.tabs[id]!;
  return isIncognitoProfile(tab.profileId) || s.windows[tab.windowId]?.kind === "private";
};

const watchOn = (s: BrowserState) => s.settings.busyTabWarnings !== false;

type StillWanted = () => boolean;

const wantedNow = (): StillWanted => {
  const run = generation;
  return () => run === generation && !isQuitting() && watchOn(useBrowser.getState());
};

const hasHiddenLoadedTab = (s: BrowserState) => {
  for (const id of webviews.keys()) if (hasTab(s, id) && !isPrivate(s, id) && canSleep(s, id)) return true;
  return false;
};

const keepsPair = (c: string, i: number, all: string) => (/[\uD800-\uDBFF]/.test(c) ? /[\uDC00-\uDFFF]/.test(all[i + 1] ?? "") : /[\uD800-\uDBFF]/.test(all[i - 1] ?? ""));

export function toastName(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const clean = text
    .replace(/[\uD800-\uDFFF]/g, (c, i: number, all: string) => (keepsPair(c, i, all) ? c : ""))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  return chars.length > NAME_CHARS ? `${chars.slice(0, NAME_CHARS - 1).join("").trimEnd()}…` : clean;
}

const quiet = (id: string, now: number) => (quietUntil.get(id) ?? 0) > now;

function hiddenAndIdle(s: BrowserState, id: string, now: number): boolean {
  if (!hasTab(s, id) || isPrivate(s, id) || !canSleep(s, id) || inUse(s, id)) return false;
  const since = hiddenSince.get(id);
  return since !== undefined && now - since >= SUSTAINED_MS && now - s.tabs[id]!.lastActiveAt >= SUSTAINED_MS;
}

function kept(s: BrowserState, id: string): boolean {
  const rules = Array.isArray(s.settings.keepActiveSites) ? s.settings.keepActiveSites : [];
  return keptTabs.has(id) || keptActive(s.tabs[id]!.url, rules);
}

const eligible = (s: BrowserState, id: string, now: number) => hiddenAndIdle(s, id, now) && !kept(s, id);

function busyTabsOf(s: BrowserState, owner: Owner, now: number): string[] | null {
  if (!owner.tabIds.length || !owner.tabIds.every((id) => hiddenAndIdle(s, id, now))) return null;
  const groups = new Map<string, string[]>();
  for (const id of owner.tabIds) {
    const host = siteToKeepActive(s.tabs[id]!.url) ?? "";
    groups.set(host, [...(groups.get(host) ?? []), id]);
  }
  for (const group of groups.values()) if (!group.some((id) => kept(s, id) || quiet(id, now))) return group;
  return null;
}

async function freshOwners(pids: number[], now: number, consent: ConsentToken | null): Promise<Map<number, Owner> | null> {
  noteBusyTab("busy_tab_owner_lookups", consent);
  const before = new Map(Object.values(useBrowser.getState().tabs).map((t) => [t.id, t.url]));
  const tasks: unknown = await listTasks().catch(() => null);
  if (!Array.isArray(tasks)) return null;
  const found = new Map<number, Owner>();
  for (const pid of pids) found.set(pid, { started: heat.get(pid)?.started ?? -1, at: now, tabIds: [], urls: new Map() });
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    const { pid, tabIds } = t as Record<string, unknown>;
    const owner = typeof pid === "number" ? found.get(pid) : undefined;
    if (!owner || !Array.isArray(tabIds)) continue;
    for (const id of tabIds) if (typeof id === "string" && id && !owner.tabIds.includes(id)) owner.tabIds.push(id);
  }
  const s = useBrowser.getState();
  for (const [pid, owner] of found) {
    if (owner.tabIds.some((id) => before.has(id) && (!hasTab(s, id) || s.tabs[id]!.url !== before.get(id)))) found.delete(pid);
    else for (const id of owner.tabIds) if (hasTab(s, id)) owner.urls.set(id, s.tabs[id]!.url);
  }
  return found;
}

const stillHot = (pid: number, started: number) => {
  const h = heat.get(pid);
  return !!h && h.started === started && h.busySince !== null;
};

async function stillBusyIn(pid: number, started: number, tabIds: string[], consent: ConsentToken | null, wanted: StillWanted): Promise<string[]> {
  if (!wanted() || !stillHot(pid, started)) return [];
  const owner = (await freshOwners([pid], clock(), consent))?.get(pid);
  if (!owner || !wanted() || !stillHot(pid, started)) return [];
  const s = useBrowser.getState();
  const now = clock();
  return tabIds.filter((id) => owner.tabIds.includes(id) && eligible(s, id, now));
}

function mayConfirm(windowId: string, warningId: number | null): boolean {
  if (!useBrowser.getState().windows[windowId]) return false;
  const slot = useToasts.getState().toasts[windowId];
  return !slot || slot.id === warningId;
}

function warnAboutTabs(windowId: string, pid: number, ownerTabIds: string[], now: number, consent: ConsentToken | null) {
  const s = useBrowser.getState();
  const started = heat.get(pid)!.started;
  const tabIds = ownerTabIds;
  const first = s.tabs[tabIds[0]!]!;
  const site = siteToKeepActive(first.url);
  const warnedUrls = new Map(tabIds.map((id) => [id, s.tabs[id]!.url]));
  const many = tabIds.length > 1;
  const nameOf = (id: string) => {
    const tab = useBrowser.getState().tabs[id] ?? first;
    return toastName(tab.customTitle || tab.title) || toastName(siteToKeepActive(tab.url)) || "A background tab";
  };
  const name = nameOf(first.id);
  const wanted = wantedNow();
  for (const id of tabIds) quietUntil.set(id, now + QUIET_AFTER_WARNING_MS);
  noteBusyTab("busy_tab_warnings", consent);
  const title = many ? `${tabIds.length} ${toastName(site) || "background"} tabs are using a lot of power` : `“${name}” is using a lot of power`;
  showToast(windowId, title, undefined, {
    icon: ICON,
    key: TOAST_KEY,
    holdMs: WARNING_HOLD_MS,
    titleLines: WARNING_TITLE_LINES,
    action: {
      title: "Sleep",
      run: () => {
        const asked = consentToken();
        void stillBusyIn(pid, started, tabIds, asked, wanted).then(async (still) => {
          if (!still.length) return noteBusyTab("busy_tab_sleep_moot", asked);
          const sameNavigation = (id: string) => {
            const now = useBrowser.getState();
            return hasTab(now, id) && now.tabs[id]!.url === warnedUrls.get(id) && heat.get(pid)?.started === started && !!owners.get(pid)?.tabIds.includes(id);
          };
          const results = await Promise.all(still.map((id) => sleepAsked(id, () => wanted() && sameNavigation(id) && eligible(useBrowser.getState(), id, clock()))));
          if (results.every((r) => r.outcome === "dropped")) return noteBusyTab("busy_tab_sleep_moot", asked);
          const asleep = still.filter((_, i) => results[i]!.outcome === "asleep");
          const kept = still.filter((_, i) => results[i]!.outcome === "kept");
          noteBusyTab(asleep.length ? "busy_tab_slept" : "busy_tab_stayed_awake", asked);
          if (!wanted() || !mayConfirm(windowId, warningId)) return;
          if (asleep.length) showToast(windowId, asleep.length > 1 ? `${asleep.length} tabs are asleep` : `“${nameOf(asleep[0]!)}” is asleep`, undefined, { icon: "moon.zzz" });
          else if (kept.length) showToast(windowId, `“${nameOf(kept[0]!)}” stayed awake`, undefined, { icon: ICON });
        });
      },
    },
    secondary: {
      title: "Keep Running",
      run: () => {
        const onWarnedSite = () => {
          const now = useBrowser.getState();
          return tabIds.every((id) => hasTab(now, id) && siteToKeepActive(now.tabs[id]!.url) === site);
        };
        if (!wanted() || !onWarnedSite()) return;
        noteBusyTab("busy_tab_kept_running", consentToken());
        if (!site) {
          for (const id of tabIds) keptTabs.add(id);
          return showToast(windowId, `“${name}” will keep running`, undefined, { icon: ICON });
        }
        void keepSiteActive(site, () => wanted() && onWarnedSite()).then((error) => {
          const saved = !error && useBrowser.getState().settings.keepActiveSites.includes(site);
          if (saved && wanted() && mayConfirm(windowId, warningId)) showToast(windowId, `${toastName(site)} will keep running`, undefined, { icon: ICON });
        });
      },
    },
  });
  const warningId = useToasts.getState().toasts[windowId]?.id ?? null;
}

async function warnFor(pids: number[], now: number, consent: ConsentToken | null, wanted: StillWanted) {
  const windowId = focusedWindowOf(useBrowser.getState());
  const free = () => !!windowId && !!useBrowser.getState().windows[windowId] && !useToasts.getState().toasts[windowId];
  if (!windowId || !free()) return;
  const stale = pids.filter((pid) => {
    const known = owners.get(pid);
    return !known || known.started !== heat.get(pid)?.started || now - known.at >= OWNERS_FRESH_MS;
  });
  if (stale.length) {
    const found = await freshOwners(stale, now, consent);
    if (!found || !wanted()) return;
    for (const [pid, owner] of found) owners.set(pid, owner);
  }
  const candidates = pids.filter((pid) => owners.has(pid) && busyTabsOf(useBrowser.getState(), owners.get(pid)!, now));
  if (!candidates.length) return;
  const confirmed = candidates.every((pid) => stale.includes(pid)) ? new Map(candidates.map((pid) => [pid, owners.get(pid)!])) : await freshOwners(candidates, now, consent);
  if (!confirmed || !wanted() || !free()) return;
  for (const pid of candidates) {
    const owner = confirmed.get(pid);
    if (!owner || owner.started !== heat.get(pid)?.started) continue;
    owners.set(pid, owner);
    const tabIds = busyTabsOf(useBrowser.getState(), owner, now);
    if (tabIds) return warnAboutTabs(windowId, pid, tabIds, now, consent);
  }
}

export async function watchBusyTabs(now = Date.now(), read: () => Promise<unknown> = childProcessCpu) {
  if (ticking || unsupported || isQuitting() || !watchOn(useBrowser.getState())) return;
  ticking = true;
  const wanted = wantedNow();
  lastTickAt = now;
  try {
    const consent = consentToken();
    noteBusyTab("busy_tab_watch_ticks", consent);
    const s = useBrowser.getState();
    const shown = shownTabIds(s);
    for (const id of hiddenSince.keys()) if (!hasTab(s, id) || shown.has(id)) hiddenSince.delete(id);
    for (const id of webviews.keys()) if (hasTab(s, id) && !shown.has(id) && s.tabs[id]!.lastActiveAt >= (hiddenSince.get(id) ?? Infinity)) hiddenSince.delete(id);
    for (const id of webviews.keys()) if (hasTab(s, id) && !shown.has(id) && !presenters.get(id) && !hiddenSince.has(id)) hiddenSince.set(id, now);
    for (const [id, at] of quietUntil) if (at <= now) quietUntil.delete(id);
    for (const id of keptTabs) if (!hasTab(s, id)) keptTabs.delete(id);
    let raw: unknown;
    try {
      raw = await read();
    } catch {
      if (wanted()) unsupported = true;
      return;
    }
    if (!wanted()) return;
    heat = readHeat(heat, validReadings(raw), now, hotCores);
    const current = useBrowser.getState();
    for (const [pid, owner] of owners) if (heat.get(pid)?.started !== owner.started || ownerMoved(current, owner)) owners.delete(pid);
    const busy = sustainedBusy(heat);
    if (busy.length) await warnFor(busy, now, consent, wanted);
  } finally {
    ticking = false;
  }
}

const ownerMoved = (s: BrowserState, owner: Owner) => owner.tabIds.some((id) => !hasTab(s, id) || s.tabs[id]!.url !== owner.urls.get(id));

let rearm = () => {};

const presenters = new Map<string, number>();

const untracked = () => {};

function markHidden(tabId: string) {
  if (!PLATFORM_FEATURES.busyTabWatch || !started || !watchOn(useBrowser.getState())) return;
  if (!presenters.get(tabId) && !hiddenSince.has(tabId)) hiddenSince.set(tabId, clock());
  rearm();
}

export function presentTab(tabId: string): () => void {
  if (!PLATFORM_FEATURES.busyTabWatch) return untracked;
  presenters.set(tabId, (presenters.get(tabId) ?? 0) + 1);
  if (started && watchOn(useBrowser.getState())) {
    hiddenSince.delete(tabId);
    rearm();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (presenters.get(tabId) ?? 1) - 1;
    if (left > 0) presenters.set(tabId, left);
    else presenters.delete(tabId);
    markHidden(tabId);
  };
}

export const noteTabHidden = (tabId: string) => markHidden(tabId);

export const noteTabLoaded = (tabId: string) => markHidden(tabId);

const loadedNow = (tabId: string) => {
  const t = useBrowser.getState().tabs[tabId];
  return !!t && hasLoadedPage(t);
};

export function trackPageArrival(tabId: string): () => void {
  if (!PLATFORM_FEATURES.busyTabWatch || !started || loadedNow(tabId)) return untracked;
  return () => {
    if (loadedNow(tabId)) markHidden(tabId);
  };
}

function dropWork() {
  hiddenSince.clear();
  generation++;
  heat = new Map();
  owners.clear();
}

let started = false;

export function startBusyTabWatch() {
  if (started || !PLATFORM_FEATURES.busyTabWatch) return;
  started = true;
  everySlowly({
    every: BUSY_TICK_MS,
    run: () => void watchBusyTabs(),
    needed: () => !unsupported && !isQuitting() && watchOn(useBrowser.getState()) && hasHiddenLoadedTab(useBrowser.getState()),
    watch: (changed) => {
      rearm = changed;
      const lifecycle = useLifecycle.subscribe(changed);
      const views = onWebviewsChanged(changed);
      const quitting = onQuittingChanged(() => {
        dropWork();
        changed();
      });
      const toggled = useBrowser.subscribeTo(["settings"], (s, prev) => {
        if (s.settings.keepActiveSites !== prev.settings.keepActiveSites) keptTabs.clear();
        if (watchOn(s) === watchOn(prev)) return;
        noteBusyTab(watchOn(s) ? "busy_tab_warnings_turned_on" : "busy_tab_warnings_turned_off", consentToken());
        if (!watchOn(s)) {
          dropWork();
          for (const windowId of Object.keys(s.windows)) hideKeyedToast(windowId, TOAST_KEY);
        }
        changed();
      });
      return () => ((rearm = () => {}), lifecycle(), views(), quitting(), toggled());
    },
  });
  if (__DEV__) (globalThis as { acBusyTabs?: unknown }).acBusyTabs = { watchBusyTabs, heat: () => heat, owners: () => owners, quietUntil, setHotCores: (cores: number) => void (hotCores = cores) };
}
