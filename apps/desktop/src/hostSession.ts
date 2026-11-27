import { registerSessionCloseHooks } from "./sessionClose";
import { useBrowser, type BrowserState, type HydrateData } from "../../browser/src/state/browser/store";
import type { BrowserWindow, MainWindow, Tab } from "../../browser/src/state/browser/types";
import type { ArdiaHost } from "./host";
import { reportHostError } from "./host.ts";
import { canonicalSessionValue, cloneSessionValue, equalSessionValue, mergeSession } from "./hostSessionMerge.ts";
import { sessionStatePatch } from "./hostSessionState.ts";
import { windowDeparture } from "./windowDeparture.ts";
import { parkWindowPins } from "../../browser/src/state/pins/parkedPins";
import { inPinnedContainer, isIncognitoProfile, snapshotTab } from "../../browser/src/state/browser/model";
import { closedWindowEntry, MAX_CLOSED_WINDOWS } from "../../browser/src/state/pins/closedTabs";
import { withPrivateWindow } from "./hostWindowProfiles.ts";
import { withSmallWindow } from "./hostSmallWindows.ts";
import { sessionWithSplitSlots, sessionWithTabPages, sessionWithTabPins } from "../../browser/src/state/session/savedShapes";
import { splitTabIds } from "../../browser/src/state/splits/splits";
import { withPinChoiceStamps, withPinChoicesOnDisk } from "./hostPinChoices.ts";
import { upgraded, type SavedObject } from "../../browser/src/lib/savedDocument";
import { SESSION_MIGRATIONS, SESSION_VERSION } from "../../browser/src/state/session/persist";
import { unclaimedAdoptId } from "./unclaimedTabs.ts";
import { adoptedPage } from "../../browser/src/state/tabs/pageSession";
import { noteSavedTopAppsMerged } from "../../browser/src/state/telemetry/topAppsSharing";
import { isOwnId, pageFromDisk, SESSION_ROWS, sessionWithListedRows, slotsFromDisk, tableRows } from "../../browser/src/state/session/savedShapes";
import { savedProfileRows } from "../../browser/src/state/session/savedSession";
import { isFields, isString } from "../../browser/src/lib/decode";

type StoredWindow = Partial<BrowserWindow> & { incognito?: unknown; originalProfileId?: unknown; sidebarOpen?: unknown };

const windowKind = (w: StoredWindow): BrowserWindow["kind"] => w.kind === "small" || w.kind === "private" || w.kind === "main" ? w.kind : w.incognito === true ? "private" : "main";
const shapedWindow = ({ incognito: _i, originalProfileId: _o, ...w }: StoredWindow) => ({ ...w, kind: windowKind(w) }) as BrowserWindow;
const ROW_REFERENCES = ["windowId", "profileId"] as const;
const savedRow = (v: unknown): v is Record<string, unknown> & { id: string } =>
  isFields(v) && isOwnId(v.id) && ROW_REFERENCES.every((key) => !(key in v) || isOwnId(v[key]));
type SessionRows = (typeof SESSION_ROWS)[number];
const tabIdList = (v: unknown) => Array.isArray(v) && v.every(isString);
const ROW_SHAPES: Record<SessionRows, (row: Record<string, unknown>) => boolean> = {
  windows: (w) => isOwnId(w.profileId) && tabIdList(w.tabIds) && isFields(w.activeTabIds) && Object.values(w.activeTabIds).every(isString),
  tabs: (t) => isOwnId(t.windowId) && isOwnId(t.profileId) && isString(t.url),
  groups: (g) => isOwnId(g.windowId) && isOwnId(g.profileId) && tabIdList(g.tabIds),
  splits: (v) => isOwnId(v.windowId) && (!("slots" in v) || slotsFromDisk(v.slots) !== null),
};
const rowOf = (rows?: SessionRows) => (v: unknown): v is Record<string, unknown> & { id: string } => savedRow(v) && (!rows || ROW_SHAPES[rows](v));
const keyedById = <T,>(list: unknown, rows?: SessionRows): Record<string, T> | undefined =>
  Array.isArray(list) ? Object.fromEntries(list.filter(rowOf(rows)).map((v) => [v.id, v])) as Record<string, T> : undefined;
const keyedTable = (table: Record<string, unknown>, rows: SessionRows) => Object.entries(table).every(([key, row]) => rowOf(rows)(row) && row.id === key);

function currentSessionShape(saved: HydrateData): HydrateData {
  const doc = { ...saved, tabs: Object.values(saved.tabs ?? {}), splits: Object.values(saved.splits ?? {}) } as unknown as SavedObject;
  const shaped = sessionWithSplitSlots(sessionWithTabPins(sessionWithTabPages(doc))) as unknown as HydrateData & { tabs: unknown; splits: unknown };
  return {
    ...shaped,
    ...(saved.tabs ? { tabs: keyedById<Tab>(shaped.tabs) } : { tabs: undefined }),
    ...(saved.splits ? { splits: keyedById(shaped.splits) } : { splits: undefined }),
    ...(saved.windows ? { windows: Object.fromEntries(Object.entries(saved.windows).map(([id, w]) => [id, shapedWindow(w as StoredWindow)])) } : {}),
  } as HydrateData;
}

const withoutAbsent = (session: HydrateData): HydrateData =>
  Object.fromEntries(Object.entries(session).filter(([, value]) => value !== undefined)) as HydrateData;
const LEGACY_TAB_FIELDS = ["navigation", "adoptId", "wakeAdoptId", "pageIn", "unloaded", "pinned", "pinnedAsRow", "tileFolder"];
const legacyTab = (tab: unknown) => !!tab && typeof tab === "object" && (!("page" in tab) || !("pin" in tab) || LEGACY_TAB_FIELDS.some((key) => key in tab));
const legacyWindow = (w: unknown) => !!w && typeof w === "object" && ("incognito" in w || "originalProfileId" in w || !["main", "private", "small"].includes((w as StoredWindow).kind ?? ""));
const legacySplit = (split: unknown) => !!split && typeof split === "object" && !("slots" in split);
const legacyEntries = (session: HydrateData) => [
  ...[...(session.closedTabs ?? []), ...(session.cleanedTabs ?? [])].map((entry) => (entry as { tab?: unknown }).tab),
  ...[...(session.closedWindows ?? []), ...(session.closedGroups ?? []), ...(session.deletedGroups ?? [])].flatMap((entry) => (entry as { tabs?: unknown[] }).tabs ?? []),
  ...Object.values(session.parkedPins ?? {}).flatMap((park) => (park as { tabs?: unknown[] }).tabs ?? []),
].some((tab) => !!tab && typeof tab === "object" && ["pinned", "pinnedAsRow", "tileFolder"].some((key) => key in tab));
const STALE_PAGE_FIELDS = ["navigation", "adoptId", "wakeAdoptId", "pageIn", "unloaded"];
const STALE_PIN_FIELDS = ["pinned", "pinnedAsRow", "tileFolder"];
const settledTab = (tab: unknown) => {
  if (!tab || typeof tab !== "object") return tab;
  const stale = [...("page" in tab ? STALE_PAGE_FIELDS : []), ...("pin" in tab ? STALE_PIN_FIELDS : [])].filter((key) => key in tab);
  return stale.length ? Object.fromEntries(Object.entries(tab).filter(([key]) => !stale.includes(key))) : tab;
};
const settledSession = (session: HydrateData): HydrateData => {
  let changed = false;
  const settle = (tab: unknown) => {
    const next = settledTab(tab);
    if (next !== tab) changed = true;
    return next;
  };
  const entries = <T,>(list: T[] | undefined, key: "tab" | "tabs") =>
    list?.map((entry) => {
      if (!entry || typeof entry !== "object" || !(key in entry)) return entry;
      const value = (entry as Record<string, unknown>)[key];
      return { ...entry, [key]: key === "tab" ? settle(value) : Array.isArray(value) ? value.map(settle) : value };
    });
  const next = {
    ...session,
    tabs: session.tabs && Object.fromEntries(Object.entries(session.tabs).map(([id, tab]) => [id, settle(tab)])),
    closedTabs: entries(session.closedTabs, "tab"),
    cleanedTabs: entries(session.cleanedTabs, "tab"),
    closedWindows: entries(session.closedWindows, "tabs"),
    closedGroups: entries(session.closedGroups, "tabs"),
    deletedGroups: entries(session.deletedGroups, "tabs"),
    parkedPins: session.parkedPins && Object.fromEntries(Object.entries(session.parkedPins).map(([id, park]) =>
      [id, park && typeof park === "object" && Array.isArray((park as { tabs?: unknown }).tabs) ? { ...park, tabs: (park as { tabs: unknown[] }).tabs.map(settle) } : park])),
  } as HydrateData;
  return changed ? withoutAbsent(next) : session;
};

const legacySession = (session: HydrateData) =>
  Object.values(session.tabs ?? {}).some(legacyTab) || Object.values(session.windows ?? {}).some(legacyWindow) ||
  Object.values(session.splits ?? {}).some(legacySplit) || legacyEntries(session);

const withAutoHideTabsSetting = (session: HydrateData): HydrateData => {
  const windows = Object.values(session.windows ?? {});
  const settings = session.settings;
  if (!settings || Object.hasOwn(settings, "autoHideTabs") || !windows.length) return session;
  return { ...session, settings: { ...settings, autoHideTabs: windows.every((w) => (w as StoredWindow).sidebarOpen === false) } };
};

const withoutTabsShown = <T extends object>(w: T): T => {
  if (!("sidebarOpen" in w)) return w;
  const { sidebarOpen: _, ...rest } = w as T & { sidebarOpen?: unknown };
  return rest as T;
};

const withoutWindowTabsShown = (session: HydrateData): HydrateData => {
  const savedWindows = Object.values(session.windows ?? {}).some((w) => "sidebarOpen" in w);
  const closedWindows = (session.closedWindows ?? []).some((c) => !!c.window && "sidebarOpen" in c.window);
  if (!savedWindows && !closedWindows) return session;
  return {
    ...session,
    ...(savedWindows ? { windows: Object.fromEntries(Object.entries(session.windows!).map(([id, w]) => [id, withoutTabsShown(w)])) } : {}),
    ...(closedWindows ? { closedWindows: session.closedWindows!.map((c) => (c.window ? { ...c, window: withoutTabsShown(c.window) } : c)) } : {}),
  };
};

const withRowsKeyed = (saved: HydrateData): HydrateData => {
  const rowsOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : isFields(value) ? tableRows(value) : []);
  const reshaped = SESSION_ROWS.filter((key) => saved[key] !== undefined && !(isFields(saved[key]) && keyedTable(saved[key], key)));
  const profiles = saved.profiles === undefined ? undefined : savedProfileRows(saved.profiles);
  const profilesChanged = !!profiles && (!isFields(saved.profiles) || Object.keys(profiles).length !== Object.keys(saved.profiles).length);
  if (!reshaped.length && !profilesChanged) return saved;
  return { ...saved, ...Object.fromEntries(reshaped.map((key) => [key, keyedById(rowsOf(saved[key]), key) ?? {}])), ...(profilesChanged ? { profiles } : {}) };
};

const sniffedSessionShape = (saved: HydrateData): HydrateData => {
  const settled = settledSession(withRowsKeyed(saved));
  return withoutWindowTabsShown(withAutoHideTabsSetting(withPinChoiceStamps(legacySession(settled) ? withoutAbsent(currentSessionShape(settled)) : settled)));
};

export const SNIFFED_SESSION_VERSION = 9;

export const linuxSessionVersion = (saved: HydrateData): number | undefined => {
  const version = (saved as { version?: unknown }).version;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : undefined;
};

function migratedSession(session: HydrateData, from: number): HydrateData | null {
  if (from >= SESSION_VERSION) return session;
  const disk = { ...sessionWithListedRows(session as unknown as SavedObject), version: from };
  const next = upgraded(disk, SESSION_VERSION, SESSION_MIGRATIONS);
  return next ? withoutAbsent(withRowsKeyed(next as unknown as HydrateData)) : null;
}

export const linuxSessionShape = (saved: HydrateData): HydrateData => {
  const stamped = linuxSessionVersion(saved);
  if (stamped !== undefined && stamped >= SESSION_VERSION) return sniffedSessionShape(saved);
  if (stamped !== undefined) {
    const migrated = migratedSession(withRowsKeyed(saved), stamped);
    return sniffedSessionShape(migrated ?? saved);
  }
  const sniffed = sniffedSessionShape(saved);
  return migratedSession(sniffed, SNIFFED_SESSION_VERSION) ?? sniffed;
};

const sessionOnDisk = (saved: HydrateData): HydrateData => withPinChoicesOnDisk(linuxSessionShape(saved), saved);

const inClosingOrder = <T extends { closedAt: number }>(entries: T[]) => [...entries].sort((a, b) => a.closedAt - b.closedAt).slice(-MAX_CLOSED_WINDOWS);

function withoutRestoredWindows(saved: HydrateData, now: number): HydrateData {
  const source = { tabs: saved.tabs ?? {}, groups: saved.groups ?? {}, splits: saved.splits ?? {}, history: {}, profiles: saved.profiles ?? {}, settings: saved.settings };
  const windows = Object.values(saved.windows ?? {}).filter((w) => w.kind === "main");
  let parkedPins = saved.parkedPins ?? {};
  for (const w of windows) parkedPins = parkWindowPins(parkedPins, w, source);
  const earlier = (saved.closedWindows ?? []).filter((c) => c.tabs.length).map(({ lastWindow: _, activePin: __, ...c }) => c);
  const closed = windows.map((w) => closedWindowEntry(
    w,
    w.tabIds.map((id) => source.tabs[id]).filter((t): t is Tab => !!t && !inPinnedContainer(source, t.id))
      .map((t) => ({ ...snapshotTab(t), active: Object.values(w.activeTabIds).includes(t.id) })),
    [],
    now,
  )).filter((c) => c.tabs.some((t) => t.url));
  return {
    ...saved, parkedPins, closedWindows: inClosingOrder([...earlier, ...closed]),
    windows: {}, windowOrder: [], tabs: {}, groups: {}, splits: {}, focusedWindowId: null,
  };
}

const seedProfile = ({ profileId, pageProfile }: ArdiaHost["bootstrap"]) =>
  pageProfile && !isIncognitoProfile(pageProfile) ? pageProfile : profileId;

type SeedTab = { url: string; page: Tab["page"]; active: boolean };

function seedTabs({ adoptTabs }: ArdiaHost["bootstrap"]): SeedTab[] {
  const seeds = (Array.isArray(adoptTabs) ? adoptTabs : []).flatMap((offer): SeedTab[] => {
    const adoptId = unclaimedAdoptId(offer);
    return adoptId && offer.url ? [{ url: offer.url, page: adoptedPage(adoptId), active: offer.active === true }] : [];
  });
  return seeds.length ? seeds : [{ url: "", page: { kind: "idle" }, active: true }];
}

const LAUNCH_WINDOW_ID = "main";

const ownRow = <T,>(table: Record<string, T> | undefined, id: string | null | undefined): T | undefined =>
  table && isOwnId(id) && Object.hasOwn(table, id) ? table[id] : undefined;
const hasSavedTabs = (saved: HydrateData, id: string | null | undefined) =>
  !!ownRow(saved.windows, id)?.tabIds.some((tabId) => !!ownRow(saved.tabs, tabId));

const movedTo = <T extends { windowId: string }>(from: string, to: string) => (entry: T): T => entry.windowId === from ? { ...entry, windowId: to } : entry;
const movedTable = <T extends { windowId: string }>(table: Record<string, T> | undefined, from: string, to: string) =>
  table && Object.fromEntries(Object.entries(table).map(([id, entry]) => [id, movedTo<T>(from, to)(entry)]));

function withLaunchWindowAdopted(saved: HydrateData, windowId: string): HydrateData {
  if (hasSavedTabs(saved, windowId)) return saved;
  const adoptable = (id: string | null | undefined): id is string => id !== windowId && ownRow(saved.windows, id)?.kind === "main" && hasSavedTabs(saved, id);
  const from = [saved.focusedWindowId, ...(saved.windowOrder ?? [])].find(adoptable);
  if (!from) return saved;
  const { [from]: adopted, [windowId]: _empty, ...others } = saved.windows!;
  const renamed = (id: string) => id === from ? windowId : id;
  return withoutAbsent({
    ...saved,
    windows: { ...others, [windowId]: { ...adopted!, id: windowId } },
    windowOrder: [...new Set((saved.windowOrder ?? []).map(renamed))],
    focusedWindowId: saved.focusedWindowId && renamed(saved.focusedWindowId),
    tabs: movedTable(saved.tabs, from, windowId),
    groups: movedTable(saved.groups, from, windowId),
    splits: movedTable(saved.splits, from, windowId),
    closedTabs: saved.closedTabs?.map(movedTo(from, windowId)),
    cleanedTabs: saved.cleanedTabs?.map(movedTo(from, windowId)),
    closedGroups: saved.closedGroups?.map(movedTo(from, windowId)),
    deletedGroups: saved.deletedGroups?.map(movedTo(from, windowId)),
  });
}

export const withoutTabWakes = (session: HydrateData): HydrateData => {
  const tabs = session.tabs;
  if (!tabs || !Object.values(tabs).some((t) => isFields(t?.page) && "wake" in t.page)) return session;
  return { ...session, tabs: Object.fromEntries(Object.entries(tabs).map(([id, t]) => [id, isFields(t?.page) && "wake" in t.page ? { ...t, page: { kind: t.page.kind } as Tab["page"] } : t])) };
};

type LaunchHints = { launchTab?: { id?: unknown; url?: unknown }; launchBackdrop?: unknown; linkProfile?: unknown };
const LAUNCH_HINTS = ["launchTab", "launchBackdrop", "linkProfile"] as const;
const focusedWindowOf = (session: HydrateData) => ownRow(session.windows, session.focusedWindowId);
const activeTabOf = (session: HydrateData) => {
  const w = focusedWindowOf(session);
  return w ? ownRow(session.tabs, w.activeTabIds[w.profileId]) : undefined;
};

function launchHintsHold(snapshot: HydrateData, canonical: HydrateData): boolean {
  const was = focusedWindowOf(canonical);
  const now = focusedWindowOf(snapshot);
  const hint = (canonical as LaunchHints).launchTab;
  const active = activeTabOf(snapshot);
  return !!was && !!now && now.profileId === was.profileId && equalSessionValue(now.tabIds, was.tabIds) &&
    equalSessionValue(now.activeTabIds, was.activeTabIds) && snapshot.lastProfileId === canonical.lastProfileId &&
    equalSessionValue(snapshot.profiles, canonical.profiles) && snapshot.settings?.restoreSession === canonical.settings?.restoreSession &&
    (snapshot.settings?.engineMode ?? "automatic") === (canonical.settings?.engineMode ?? "automatic") &&
    (!hint || (hint.id === active?.id && hint.url === active?.url && active?.url === activeTabOf(canonical)?.url));
}

const UNLOADED_PAGES: ReadonlySet<Tab["page"]["kind"]> = new Set(["idle", "asleep", "frozen"]);

export function withSavedOnlyFields(snapshot: HydrateData, canonical: HydrateData, live?: Record<string, Tab>, loaded: ReadonlySet<string> = new Set()): HydrateData {
  let tabs = snapshot.tabs;
  for (const [id, tab] of Object.entries(snapshot.tabs ?? {})) {
    const saved = ownRow(canonical.tabs, id);
    const wake = saved && saved.url === tab.url && saved.profileId === tab.profileId ? pageFromDisk(saved.page).wake : undefined;
    const runtime = ownRow(live, id)?.page ?? tab.page;
    if (!wake || loaded.has(id) || !UNLOADED_PAGES.has(runtime.kind) || (tab.page.kind !== "idle" && tab.page.kind !== "asleep")) continue;
    if (tabs === snapshot.tabs) tabs = { ...snapshot.tabs };
    tabs![id] = { ...tab, page: { kind: tab.page.kind, wake } };
  }
  const hints = LAUNCH_HINTS.filter((key) => (canonical as LaunchHints)[key] !== undefined);
  const kept = hints.length && launchHintsHold(snapshot, canonical) ? Object.fromEntries(hints.map((key) => [key, (canonical as LaunchHints)[key]])) : {};
  return tabs === snapshot.tabs && !Object.keys(kept).length ? snapshot : { ...snapshot, tabs, ...kept };
}

export function initialHostSession(host: ArdiaHost, saved: HydrateData | null | undefined, now = Date.now(), onRestored?: (windowId: string) => void): HydrateData {
  return withoutTabWakes(initialSessionWithWakes(host, saved, now, onRestored));
}

function initialSessionWithWakes(host: ArdiaHost, saved: HydrateData | null | undefined, now: number, onRestored?: (windowId: string) => void): HydrateData {
  const { windowId } = host.bootstrap;
  const profileId = seedProfile(host.bootstrap);
  if (!windowId || !profileId || /[\\/\0]/.test(windowId + profileId)) throw new Error("Invalid Ardia host bootstrap IDs");
  if (saved) saved = linuxSessionShape(saved);
  if (host.bootstrap.startup !== false && saved?.settings?.restoreSession === false) saved = withoutRestoredWindows(saved, now);
  if (saved?.closedWindows) saved = { ...saved, closedWindows: inClosingOrder(saved.closedWindows) };
  const privateSession = withPrivateWindow(host, saved ?? {});
  if (privateSession) return privateSession;
  const smallSession = withSmallWindow(host, saved ?? {}, undefined, now);
  if (smallSession) return smallSession;
  if (saved && host.bootstrap.startup === true && windowId === LAUNCH_WINDOW_ID) saved = withLaunchWindowAdopted(saved, windowId);
  const profile = { id: profileId, name: "Personal", color: "plum" as const, icon: null, createdAt: now };
  const profiles = { ...saved?.profiles };
  profiles[profileId] ??= profile;
  if (saved && hasSavedTabs(saved, windowId)) {
    onRestored?.(windowId);
    return { ...saved, profiles, focusedWindowId: windowId };
  }
  const seeds = seedTabs(host.bootstrap);
  const tabs: Tab[] = seeds.map(({ url, page }) => ({
    id: `t_${crypto.randomUUID()}`, windowId, profileId, url, title: "", favicon: null, pin: null, muted: false, zoom: 1,
    customTitle: null, customIcon: null, pinnedUrl: null, page, openerId: null, createdAt: now, lastActiveAt: now,
  }));
  const activeTab = tabs[Math.max(0, seeds.findIndex((seed) => seed.active))]!;
  const browserWindow: BrowserWindow = {
    id: windowId, profileId, kind: "main", tabIds: tabs.map((tab) => tab.id), activeTabIds: { [profileId]: activeTab.id }, frame: null, createdAt: now,
  };
  return {
    ...saved, profiles, profileOrder: [...new Set([...(saved?.profileOrder ?? []), profileId])],
    windows: { ...saved?.windows, [windowId]: browserWindow },
    windowOrder: [...new Set([...(saved?.windowOrder ?? []), windowId])],
    tabs: { ...saved?.tabs, ...Object.fromEntries(tabs.map((tab) => [tab.id, tab])) }, focusedWindowId: windowId,
  };
}

const publicProfile = (profile: string) => !profile.startsWith("incognito:");
const savedPageKind = (tab: Tab): Tab["page"] => ({ kind: tab.page.kind === "asleep" || tab.page.kind === "frozen" ? "asleep" : "idle" });
const publicTabs = (entry: { tabs: { profileId: string }[] }) => entry.tabs.every((tab) => publicProfile(tab.profileId));
const publicTable = <T,>(table: Record<string, T>) => Object.fromEntries(Object.entries(table).filter(([id]) => publicProfile(id)));

export function hydrateLaunchSession(saved: HydrateData | null | undefined, initial: HydrateData, { retiredDefaultsWaitForSync = false } = {}) {
  noteSavedTopAppsMerged(saved?.topAppsMerged ?? "");
  useBrowser.getState().hydrate({ ...initial, retiredDefaultsWaitForSync });
}

export function snapshotHostSession(s: BrowserState): HydrateData {
  const windows = Object.fromEntries(Object.values(s.windows).filter((w): w is MainWindow => w.kind === "main").map(({ chromeWindow: _, ...w }) => [w.id, w]));
  const tabs = Object.fromEntries(Object.values(s.tabs)
    .filter((t) => windows[t.windowId] && publicProfile(t.profileId) && !Object.values(s.peeks).some((p) => p.tabId === t.id))
    .map((tab): [string, Tab] => [tab.id, { ...tab, page: savedPageKind(tab) }]));
  for (const w of Object.values(windows)) {
    w.tabIds = w.tabIds.filter((id) => tabs[id]);
    w.activeTabIds = Object.fromEntries(Object.entries(w.activeTabIds).filter(([, id]) => tabs[id]));
  }
  return {
    profiles: publicTable(s.profiles), profileOrder: s.profileOrder.filter(publicProfile), orphanedProfileData: s.orphanedProfileData,
    windows, windowOrder: s.windowOrder.filter((id) => windows[id]), tabs,
    focusedWindowId: s.ui.focusOrder.find((id) => windows[id]) ?? null, lastProfileId: s.ui.lastProfileId,
    groups: Object.fromEntries(Object.entries(s.groups).filter(([, g]) => windows[g.windowId] && publicProfile(g.profileId)).map(([id, g]) => [id, { ...g, tabIds: g.tabIds.filter((key) => tabs[key]) }])),
    splits: Object.fromEntries(Object.entries(s.splits).filter(([, split]) => windows[split.windowId] && splitTabIds(split).every((key) => tabs[key]))),
    closedTabs: s.closedTabs.filter((c) => publicProfile(c.tab.profileId)), closedWindows: s.closedWindows.filter(publicTabs),
    closedGroups: s.closedGroups.filter(publicTabs), deletedGroups: s.deletedGroups.filter(publicTabs), cleanedTabs: s.cleanedTabs.filter((c) => publicProfile(c.tab.profileId)),
    parkedPins: publicTable(s.parkedPins), pinChoices: publicTable(s.pinChoices), pinSync: publicTable(s.pinSync),
    topAppsMerged: s.topAppsMerged, syncMark: s.syncMark,
    settings: s.settings, settingsMeta: s.settingsMeta,
    ...{ version: SESSION_VERSION },
  };
}

type SessionPair = { base: HydrateData; session: HydrateData };
const sessionObject = (value: unknown): value is HydrateData => value !== null && typeof value === "object" && !Array.isArray(value);

const listRowsKeyed = (session: HydrateData): HydrateData => {
  const lists = SESSION_ROWS.filter((key) => Array.isArray(session[key]));
  return lists.length ? { ...session, ...Object.fromEntries(lists.map((key) => [key, keyedById(session[key])])) } : session;
};
const listedOnDisk = (onDisk: unknown) => new Set(SESSION_ROWS.filter((key) => sessionObject(onDisk) && Array.isArray(onDisk[key])));
const inDiskForm = (session: HydrateData, listed: ReadonlySet<SessionRows>): HydrateData => {
  const tables = [...listed].filter((key) => isFields(session[key]));
  return tables.length ? { ...session, ...Object.fromEntries(tables.map((key) => [key, Object.values(session[key]!)])) } as HydrateData : session;
};

export function createSessionWriter(host: ArdiaHost, initial: HydrateData = {}, onCanonical?: (base: HydrateData, session: HydrateData) => void, onDisk: unknown = initial) {
  let listed = listedOnDisk(onDisk);
  const noteDisk = (raw: unknown) => void (sessionObject(raw) && (listed = listedOnDisk(raw)));
  const diskPair = (pair: SessionPair): SessionPair => listed.size ? { base: inDiskForm(pair.base, listed), session: inDiskForm(pair.session, listed) } : pair;
  let writes = Promise.resolve();
  let canonical = cloneSessionValue(initial);
  let observation = 0;
  let generation = 0;
  let pending: SessionPair | undefined;
  let latest: SessionPair | undefined;
  let issued: SessionPair | undefined;
  let inFlight: SessionPair | undefined;
  let issuedFailed = false;
  let failedWrite: Promise<void> | undefined;
  let dirty = false;
  let finalized = false;
  let finalWrite = Promise.resolve();
  const acceptCanonical = (session: HydrateData) => {
    canonical = cloneSessionValue(session);
    observation++;
  };
  const reconcile = (session: HydrateData, needsWrite: boolean) => {
    if (finalized) return;
    generation++;
    latest = { base: cloneSessionValue(canonical), session: cloneSessionValue(session) };
    pending = needsWrite ? latest : undefined;
    dirty = needsWrite;
  };
  const flush = () => {
    if (finalized) return finalWrite;
    if (!pending) return writes;
    const pair = pending;
    const version = generation;
    pending = undefined;
    const write = writes.catch((error) => { if (!finalized) reportHostError(error); }).then(async () => {
      if (finalized || version !== generation) return;
      issued = pair;
      issuedFailed = false;
      failedWrite = undefined;
      const observed = observation;
      inFlight = pair;
      try {
        const reply = await host.invoke("session.write", diskPair(pair));
        noteDisk(reply);
        if (finalized) return;
        const reconciled = generation;
        if (observed === observation && sessionObject(reply)) {
          const onDisk = sessionOnDisk(reply);
          acceptCanonical(onDisk);
          onCanonical?.(pair.session, onDisk);
        } else if (sessionObject(reply)) {
          canonical = mergeSession(listRowsKeyed(pair.base), pair.session, canonical);
        }
        const stale = sessionObject(reply) && generation === reconciled && dirty && latest !== pair ? latest : undefined;
        const requeue = !!stale && !pending;
        if (stale) {
          if (requeue) generation++;
          latest = { base: cloneSessionValue(canonical), session: stale.session };
          pending = latest;
        }
        if (latest === pair) dirty = false;
        if (requeue) void flush().catch(() => {});
      } catch (error) {
        if (issued === pair) {
          issuedFailed = true;
          failedWrite = write;
        }
        throw error;
      } finally {
        if (inFlight === pair) inFlight = undefined;
      }
    });
    writes = write;
    return writes;
  };
  const drain = async () => {
    if (issuedFailed && failedWrite === writes) {
      if (dirty && !pending && latest) pending = latest;
      else if (!dirty && !pending) {
        writes = Promise.resolve();
        issuedFailed = false;
        failedWrite = undefined;
      }
    }
    for (let pass = 0; pass < 32; pass++) {
      const active = flush();
      await active;
      if (active === writes && !pending) return;
    }
    throw new Error("The session is still changing; save it again before closing");
  };
  const flushFinal = () => {
    if (finalized) return finalWrite;
    finalized = true;
    generation++;
    pending = undefined;
    if (!dirty || !latest || latest === issued && !issuedFailed) return finalWrite;
    const final = inFlight ? { base: mergeSession(listRowsKeyed(inFlight.base), inFlight.session, listRowsKeyed(latest.base)), session: latest.session } : latest;
    issued = latest;
    try {
      finalWrite = Promise.resolve(host.invoke("session.write", diskPair(final))).then(() => {});
    } catch (error) {
      finalWrite = Promise.reject(error);
    }
    return finalWrite;
  };
  return { queue: (session: HydrateData) => reconcile(session, true), reconcile, acceptCanonical, noteDisk, diskPair, flush, drain, flushFinal };
}

type SessionStore = {
  getState(): BrowserState;
  setState(patch: Partial<BrowserState>): void;
  subscribe(listener: (s: BrowserState) => void): () => void;
};

const withoutFocus = ({ focusedWindowId: _, lastProfileId: _last, ...session }: HydrateData) => session;
const sessionSources = (s: BrowserState) => [s.profiles, s.profileOrder, s.orphanedProfileData, s.windows, s.windowOrder, s.tabs, s.groups, s.splits, s.peeks, s.closedTabs, s.closedWindows, s.closedGroups, s.deletedGroups, s.cleanedTabs, s.parkedPins, s.pinChoices, s.pinSync, s.topAppsMerged, s.syncMark, s.settings, s.settingsMeta, s.ui.focusOrder, s.ui.lastProfileId];

type StandIn = { windowId: string; profileId?: string };

function windowStandIn(host: ArdiaHost, state: BrowserState, initial: HydrateData): StandIn | undefined {
  const { windowId, startup, chromeMade } = host.bootstrap;
  const w = state.windows[windowId];
  if (startup !== false || chromeMade || w?.kind !== "main" || initial.windows?.[windowId]) return undefined;
  return initial.profiles?.[w.profileId] ? { windowId } : { windowId, profileId: w.profileId };
}

function withoutStandIn(state: BrowserState, standIn: StandIn | undefined): BrowserState {
  if (!standIn) return state;
  const { [standIn.windowId]: _, ...windows } = state.windows;
  const profiles = { ...state.profiles };
  if (standIn.profileId) delete profiles[standIn.profileId];
  return {
    ...state, windows, profiles,
    windowOrder: state.windowOrder.filter((id) => id !== standIn.windowId),
    profileOrder: state.profileOrder.filter((id) => id !== standIn.profileId),
    ui: { ...state.ui, focusOrder: state.ui.focusOrder.filter((id) => id !== standIn.windowId) },
  };
}

export function startHostPersistence(host: ArdiaHost, store: SessionStore, stored: HydrateData = host.bootstrap.session ?? {}, snapshot: (state: BrowserState, canonical: HydrateData) => HydrateData = snapshotHostSession) {
  const initial = linuxSessionShape(stored);
  let canonical = initial;
  let standIn = windowStandIn(host, store.getState(), initial);
  const loadedTabs = new Set<string>();
  let trackedTabs: BrowserState["tabs"] | undefined;
  const trackLoaded = (state: BrowserState) => {
    if (state.tabs === trackedTabs) return;
    trackedTabs = state.tabs;
    for (const id of loadedTabs) if (!Object.hasOwn(state.tabs, id)) loadedTabs.delete(id);
    for (const [id, tab] of Object.entries(state.tabs)) if (!UNLOADED_PAGES.has(tab.page.kind)) loadedTabs.add(id);
  };
  const snapshotOf = (state: BrowserState) => {
    trackLoaded(state);
    return withSavedOnlyFields(snapshot(withoutStandIn(state, standIn), canonical), canonical, state.tabs, loadedTabs);
  };
  const written = withPinChoicesOnDisk(equalSessionValue(initial, stored) ? initial : stored, stored);
  const writer = createSessionWriter(host, written, (base, session) => receive(base, session), stored);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = canonicalSessionValue(equalSessionValue({ ...initial, version: undefined }, { ...written, version: undefined }) ? initial : written)!;
  let lastSources: unknown[] = [];
  let closing = false;
  const closeTokens = new Set<string>();
  let frozen: HydrateData | undefined;
  let applying = false;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    void writer.flush().catch((error) => { if (!closing) reportHostError(error); });
  };
  const queue = (s: BrowserState) => {
    if (closing || applying || closeTokens.size) return;
    const sources = sessionSources(s);
    if (sources.every((source, index) => source === lastSources[index])) return;
    lastSources = sources;
    const session = snapshotOf(s);
    const json = canonicalSessionValue(session)!;
    if (json === last) return;
    last = json;
    writer.queue(session);
    timer ??= setTimeout(flush, 300);
  };
  const receive = (base: HydrateData, onDisk: HydrateData) => {
    if (closing) return;
    const session = withPinChoiceStamps(onDisk);
    const state = store.getState();
    const local = frozen ?? snapshotOf(state);
    canonical = session;
    const merged = mergeSession(base, local, session);
    if (standIn && merged.windows?.[standIn.windowId]) standIn = undefined;
    const runtime = withoutTabWakes({ ...merged, ...(merged.closedWindows && { closedWindows: inClosingOrder(merged.closedWindows) }), settings: { ...state.settings, ...merged.settings } });
    const patch = sessionStatePatch(state, snapshotHostSession(withoutStandIn(state, standIn)), runtime);
    applying = true;
    try {
      if (Object.keys(patch).length) store.setState(patch);
    } finally {
      applying = false;
    }
    const current = store.getState();
    const snapshot = snapshotOf(current);
    if (closeTokens.size) frozen = snapshot;
    const outstanding = !equalSessionValue(withoutFocus(snapshot), withoutFocus(onDisk));
    lastSources = sessionSources(current);
    last = canonicalSessionValue(snapshot)!;
    writer.reconcile(snapshot, outstanding);
    if (outstanding && !closeTokens.size) timer ??= setTimeout(flush, 300);
    else {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const stopCloseHooks = registerSessionCloseHooks({
    quiesce: (token) => {
      if (!closeTokens.size) {
        queue(store.getState());
        frozen = snapshotOf(store.getState());
      }
      closeTokens.add(token);
      clearTimeout(timer);
      timer = undefined;
    },
    resume: (token) => {
      closeTokens.delete(token);
      if (closeTokens.size) return;
      frozen = undefined;
      queue(store.getState());
    },
  });
  queue(store.getState());
  trackLoaded(store.getState());
  const stopTracking = store.subscribe(trackLoaded);
  const stop = store.subscribe(queue);
  const stopEvents = host.onEvent((module, event, payload) => {
    if (closing || module !== "ArdiaHost" || event !== "session" || !sessionObject(payload)) return;
    const update = payload as { base?: unknown; session?: unknown };
    if (!sessionObject(update.base) || !sessionObject(update.session)) return;
    const session = sessionOnDisk(update.session);
    writer.noteDisk(update.session);
    writer.acceptCanonical(session);
    receive(linuxSessionShape(update.base), session);
  });
  if (standIn) {
    void Promise.resolve(host.invoke("session.read", {})).then((saved) => {
      if (closing || !sessionObject(saved)) return;
      const session = sessionOnDisk(saved);
      writer.noteDisk(saved);
      writer.acceptCanonical(session);
      receive(canonical, session);
    }).catch(reportHostError);
  }
  const final = () => {
    if (closing) return;
    if (closeTokens.size) { closing = true; clearTimeout(timer); timer = undefined; return; }
    queue(store.getState());
    closing = true;
    clearTimeout(timer);
    timer = undefined;
    void writer.flushFinal().catch(() => {});
  };
  const onVisibility = () => { if (document.hidden) flush(); };
  const stopClosing = host.onBeforeClose?.(final);
  if (!host.onBeforeClose) window.addEventListener("pagehide", final);
  document.addEventListener("visibilitychange", onVisibility);
  const dispose = () => {
    stopCloseHooks();
    stop();
    stopTracking();
    stopEvents();
    if (!closing) flush();
    stopClosing?.();
    window.removeEventListener("pagehide", final);
    document.removeEventListener("visibilitychange", onVisibility);
  };
  const departure = (windowId: string) => {
    const state = store.getState();
    return writer.diskPair({ base: snapshotOf(state), session: snapshotOf(windowDeparture(state, windowId)) });
  };
  return Object.assign(dispose, { flush: () => { queue(store.getState()); clearTimeout(timer); timer = undefined; return writer.drain(); }, departure });
}
