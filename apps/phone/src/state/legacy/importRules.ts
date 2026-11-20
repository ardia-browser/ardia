import { acceptsPreference, parsePreferences, PREFERENCE_KEYS, type Preferences } from "../settings/preferences.ts";
import type { VisitTransition } from "../store/browserDatabase.ts";
import { TAB_ORIGINS, isSyncableUrl, type BrowserTab, type TabOrigin } from "../tabs/tabModels.ts";

export const LEGACY_RECEIPT_KEY = "legacy.receipt";
export const LEGACY_FRESH_KEY = "legacy.startedFresh";
export const LEGACY_FRESH_VERSION = "1";
export const OLD_IMPORT_KEY = "legacy.importVersion";
export const OLD_IMPORTED = "1";
export const RECEIPT_VERSION = 1;

export type LegacyTabInput = {
  id: string;
  url: string;
  title: string;
  created: number;
  lastActive: number;
  position: number;
  origin: string;
  archivedAt?: number;
  profileSyncId?: string;
  savedState?: string;
  faviconUrl?: string;
  themeColor?: string;
  snapshotPath?: string;
  receivedKey?: string;
  receivedFromDevice?: string;
};

export type LegacyVisitInput = { url: string; title: string; visitedAt: number; transition: string; profileSyncId?: string };

export type LegacyReadInput = {
  tabs: LegacyTabInput[];
  archive: LegacyTabInput[];
  selectedTabId: string | null;
  preferences: Record<string, unknown>;
};

export type LegacyUnusableReason = "schema" | "corrupt" | "locked" | "io";

export type LegacyCounts = { tabs: number; archive: number; visits: number };

export type LegacySourceInput =
  | { kind: "none" }
  | { kind: "pending"; counts: LegacyCounts }
  | { kind: "done"; outcome?: "imported" | "startedFresh" }
  | { kind: "unusable"; reason: LegacyUnusableReason };

export type LegacyReceipt = { version: 1; tabs: number; archive: number; visits: number; preferences: number };

export type ImportPlatform = "android" | "ios";

export type ImportVisit = { url: string; title: string; visitedAt: number; profileSyncId: string | null; transition: VisitTransition };

export type Tally = Record<string, number>;

export const countReason = (tally: Tally, reason: string) => {
  tally[reason] = (tally[reason] ?? 0) + 1;
};

const UNUSABLE: readonly LegacyUnusableReason[] = ["schema", "corrupt", "locked", "io"];

export const unusableReason = (raw: unknown): LegacyUnusableReason => ((UNUSABLE as readonly unknown[]).includes(raw) ? (raw as LegacyUnusableReason) : "io");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const optionalString = (value: unknown) => value === undefined || value === null || typeof value === "string";

export const isLegacyCounts = (value: unknown): value is LegacyCounts => isRecord(value) && isCount(value.tabs) && isCount(value.archive) && isCount(value.visits);

export const isLegacyRead = (value: unknown): value is LegacyReadInput =>
  isRecord(value) &&
  Array.isArray(value.tabs) &&
  Array.isArray(value.archive) &&
  (value.selectedTabId === undefined || value.selectedTabId === null || typeof value.selectedTabId === "string") &&
  isRecord(value.preferences);

export const isVisitPage = (value: unknown): value is { visits: unknown[]; next: number | null } =>
  isRecord(value) && Array.isArray(value.visits) && (value.next === null || value.next === undefined || isFiniteNumber(value.next));

const isLegacyTab = (tab: unknown): tab is LegacyTabInput =>
  isRecord(tab) &&
  typeof tab.id === "string" &&
  typeof tab.url === "string" &&
  typeof tab.title === "string" &&
  isFiniteNumber(tab.created) &&
  isFiniteNumber(tab.lastActive) &&
  isFiniteNumber(tab.position) &&
  typeof tab.origin === "string" &&
  (tab.archivedAt === undefined || tab.archivedAt === null || isFiniteNumber(tab.archivedAt)) &&
  ["profileSyncId", "savedState", "faviconUrl", "themeColor", "snapshotPath", "receivedKey", "receivedFromDevice"].every((key) => optionalString(tab[key]));

const isLegacyVisit = (visit: unknown): visit is LegacyVisitInput =>
  isRecord(visit) &&
  typeof visit.url === "string" &&
  typeof visit.title === "string" &&
  isFiniteNumber(visit.visitedAt) &&
  typeof visit.transition === "string" &&
  optionalString(visit.profileSyncId);

const TRANSITIONS: readonly VisitTransition[] = ["typed", "link", "backForward", "formSubmit", "restored", "other"];

export const importTransition = (raw: string): VisitTransition => ((TRANSITIONS as readonly string[]).includes(raw) ? (raw as VisitTransition) : "other");

const originOf = (raw: string): TabOrigin => ((TAB_ORIGINS as readonly string[]).includes(raw) ? (raw as TabOrigin) : "typed");

const tabUrlKept = (url: string) => isSyncableUrl(url) || url === "about:blank";

export const importId = (platform: ImportPlatform) => (id: string) => (platform === "ios" ? id.toLowerCase() : id);

export function importTab(tab: LegacyTabInput, archived: boolean, id: string): BrowserTab {
  return {
    id,
    url: tab.url,
    title: tab.title,
    created: tab.created,
    lastActive: tab.lastActive,
    archivedAt: archived ? (tab.archivedAt ?? tab.lastActive) : null,
    position: tab.position,
    profileSyncId: tab.profileSyncId ?? null,
    faviconUrl: tab.faviconUrl && isSyncableUrl(tab.faviconUrl) ? tab.faviconUrl : null,
    themeColorHex: tab.themeColor ?? null,
    snapshotFileName: tab.snapshotPath ? `file://${tab.snapshotPath}` : null,
    origin: originOf(tab.origin),
    receivedKey: tab.receivedKey ?? null,
    receivedFromDevice: tab.receivedFromDevice ?? null,
    pinnedKey: null,
    isPrivate: false,
  };
}

export type TabPlan = {
  tabs: BrowserTab[];
  selectedId: string | null;
  states: Map<string, string>;
  excluded: { tabs: Tally; archive: Tally };
};

export function planTabs(read: LegacyReadInput, platform: ImportPlatform): TabPlan {
  const idOf = importId(platform);
  const seen = new Set<string>();
  const tabs: BrowserTab[] = [];
  const states = new Map<string, string>();
  const excluded = { tabs: {} as Tally, archive: {} as Tally };
  const take = (raw: unknown, archived: boolean) => {
    const tally = archived ? excluded.archive : excluded.tabs;
    if (!isLegacyTab(raw) || raw.id.trim() === "") return countReason(tally, "malformed");
    const id = idOf(raw.id);
    if (seen.has(id)) return countReason(tally, "duplicate");
    if (!tabUrlKept(raw.url)) return countReason(tally, "notWeb");
    seen.add(id);
    tabs.push(importTab(raw, archived, id));
    if (raw.savedState) states.set(id, raw.savedState);
  };
  for (const tab of read.tabs) take(tab, false);
  for (const tab of read.archive) take(tab, true);
  const wanted = read.selectedTabId ? idOf(read.selectedTabId) : null;
  const selectedId = tabs.some((tab) => tab.archivedAt === null && tab.id === wanted) ? wanted : null;
  return { tabs, selectedId, states, excluded };
}

export function planVisit(raw: unknown): ImportVisit | "malformed" | "notWeb" {
  if (!isLegacyVisit(raw)) return "malformed";
  if (!isSyncableUrl(raw.url)) return "notWeb";
  return { url: raw.url, title: raw.title, visitedAt: raw.visitedAt, profileSyncId: raw.profileSyncId ?? null, transition: importTransition(raw.transition) };
}

const PREFERENCE_NAMES = new Map<string, keyof Preferences>(Object.entries(PREFERENCE_KEYS).map(([name, key]) => [key, name as keyof Preferences]));

export function hiddenHistoryFromSeconds(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const spaces: Record<string, Record<string, number>> = {};
  for (const [space, hidden] of Object.entries(parsed)) {
    if (!space || !isRecord(hidden)) return undefined;
    const urls: Record<string, number> = {};
    for (const [url, seconds] of Object.entries(hidden)) {
      if (!url || typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
      urls[url] = Math.round(seconds * 1000);
    }
    if (Object.keys(urls).length) spaces[space] = urls;
  }
  return Object.keys(spaces).length ? JSON.stringify(spaces) : undefined;
}

const OTHER_STORED_KEYS: Record<string, (raw: string) => string | undefined> = {
  "tabs.deckGrid": (raw) => (raw === "true" || raw === "false" ? raw : undefined),
  "library.hiddenHistory": hiddenHistoryFromSeconds,
};

export function importPreferences(stored: Record<string, unknown>): { values: Record<string, string>; excluded: Tally } {
  const values: Record<string, string> = {};
  const excluded: Tally = {};
  for (const key of Object.keys(stored).sort()) {
    const value = stored[key];
    const name = PREFERENCE_NAMES.get(key);
    const other = OTHER_STORED_KEYS[key];
    if (other) {
      const converted = typeof value === "string" || typeof value === "boolean" ? other(String(value)) : undefined;
      if (converted === undefined) countReason(excluded, "badValue");
      else values[key] = converted;
    } else if (!name) countReason(excluded, "unknownKey");
    else if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") countReason(excluded, "badValue");
    else if (String(value) === "") countReason(excluded, "empty");
    else if (!acceptsPreference(name, String(value))) countReason(excluded, "badValue");
    else values[key] = String(value);
  }
  return { values, excluded };
}

export function samePreference(key: string, written: string | undefined, wanted: string): boolean {
  if (OTHER_STORED_KEYS[key]) return written === wanted;
  const name = PREFERENCE_NAMES.get(key);
  if (written !== wanted || !name) return false;
  return parsePreferences({ [key]: written })[name] === parsePreferences({ [key]: wanted })[name];
}

export function readReceipt(raw: string | undefined): LegacyReceipt | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== RECEIPT_VERSION) return null;
  const { tabs, archive, visits, preferences } = parsed;
  if (![tabs, archive, visits, preferences].every(isCount)) return null;
  return { version: RECEIPT_VERSION, tabs: tabs as number, archive: archive as number, visits: visits as number, preferences: preferences as number };
}

export const importChoices = (failures: number, canStartWithout: boolean) => ({ tryAgain: true, startWithout: canStartWithout && failures >= 2 });

export function exclusionCounts(groups: Record<string, Tally>): string {
  return Object.entries(groups)
    .flatMap(([group, tally]) => Object.entries(tally).map(([reason, count]) => `${group}.${reason}=${count}`))
    .join(" ");
}
