import type { HydrateData } from "../browser/store";
import type { BrowserWindow, ClosedWindow, ParkedPins, Profile, SplitView, Tab } from "../browser/types";
import { parseSaved, type Migrations, type SavedObject } from "../../lib/savedDocument";
import { sessionWithCleanUpMinutes } from "../settings/cleanUpAfter";
import { parseSettingsMeta } from "../settings/settings";
import { sessionWithNewTabLinksInLittleArdia, sessionWithSettingsMeta, sessionWithUnreadCountsOffByDefault } from "../settings/settingsMigrations";
import { sessionWithOwnTabMutes } from "../tabs/mute";
import { pinChoicesFromDisk, sessionWithPinChoiceStamps } from "../pins/pinChoices";
import { isFields, isString, isStringList } from "../../lib/decode";
import { pageFromDisk, pinFromDisk, splitsChecked, sessionWithSplitSlots, sessionWithTabPages, sessionWithTabPins, slotsFromDisk } from "./savedShapes";
import { profilesKeepingLegacyDots } from "../profiles/switcherMark";
import { profilesWithOwnLooks } from "../../lib/presetLook";
import { layoutDrops } from "../browser/hydratedLayout";

export const SESSION_VERSION = 11;
export const SESSION_MIGRATIONS: Migrations = { 2: sessionWithCleanUpMinutes, 3: sessionWithOwnTabMutes, 4: sessionWithTabPages, 5: sessionWithTabPins, 6: sessionWithSplitSlots, 7: sessionWithSettingsMeta, 8: sessionWithPinChoiceStamps, 9: sessionWithNewTabLinksInLittleArdia, 10: sessionWithUnreadCountsOffByDefault };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isString) : []);
const has = (o: SavedObject, keys: readonly string[]) => keys.every((k) => isString(o[k]));
export const rows = <T,>(v: unknown, ok: (o: SavedObject) => boolean): T[] => (Array.isArray(v) ? v.filter((o): o is SavedObject => isFields(o) && ok(o)) : []) as T[];
const byProfile = <T,>(v: unknown, ok: (o: SavedObject) => boolean = () => true): Record<string, T> =>
  (isFields(v) ? Object.fromEntries(Object.entries(v).filter(([, o]) => isFields(o) && ok(o))) : {}) as Record<string, T>;
const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]));

const windowOk = (o: SavedObject) => has(o, ["id", "profileId"]) && isStringList(o.tabIds) && isFields(o.activeTabIds) && Object.values(o.activeTabIds).every(isString);
const tabOk = (o: SavedObject) => has(o, ["id", "windowId", "profileId", "url"]);
const groupOk = (o: SavedObject) => has(o, ["id", "windowId", "profileId"]) && isStringList(o.tabIds);
const splitOk = (o: SavedObject) => has(o, ["id", "windowId"]) && (o.orientation === "horizontal" || o.orientation === "vertical") && !!slotsFromDisk(o.slots);
const snapshotOk = (o: unknown) => isFields(o) && has(o, ["url", "profileId"]);
const closedTabOk = (o: SavedObject) => isString(o.id) && snapshotOk(o.tab);
const tabListOk = (o: SavedObject) => isString(o.id) && Array.isArray(o.tabs) && o.tabs.every(snapshotOk);
const profileOk = (o: SavedObject) => has(o, ["id", "name"]);
const parkedOk = (o: SavedObject) => Array.isArray(o.tabs) && o.tabs.every(snapshotOk) && Array.isArray(o.groups) && o.groups.every((g) => isFields(g) && isString(g.id));

export type SavedSession = Omit<HydrateData, "history" | "bookmarks" | "downloads"> & {
  windows: Record<string, BrowserWindow>;
  tabs: Record<string, Tab>;
  windowsAgainstAutoHideTabs: number;
};

function settingsWithAutoHideTabs(settings: unknown, windows: SavedObject[]): HydrateData["settings"] {
  if (!isFields(settings)) return undefined;
  if ("autoHideTabs" in settings || !windows.length) return settings as HydrateData["settings"];
  return { ...settings, autoHideTabs: windows.every((w) => w.sidebarOpen === false) } as HydrateData["settings"];
}

function withoutSavedTabsShown(closed: ClosedWindow): ClosedWindow {
  if (!isFields(closed.window)) return closed;
  const { sidebarOpen: _, ...window } = closed.window as ClosedWindow["window"] & { sidebarOpen?: unknown };
  return { ...closed, window };
}

function windowsAgainstAutoHideTabs(settings: HydrateData["settings"], windows: SavedObject[]): number {
  const hidden = !!settings?.autoHideTabs;
  return windows.filter((w) => typeof w.autoHideTabs !== "boolean" && typeof w.sidebarOpen === "boolean" && w.sidebarOpen === hidden).length;
}

const notInherited = (id: string) => !(id in Object.prototype);
const ownId = (value: unknown) => (isString(value) && notInherited(value) ? value : null);

export function parseSession(json: string | null | undefined): SavedSession | null {
  const raw = parseSaved(json, SESSION_VERSION, SESSION_MIGRATIONS);
  return raw ? sessionFromSaved(raw) : null;
}

export function sessionFromSaved(raw: SavedObject): SavedSession {
  const savedWindowRows = rows<SavedObject>(raw.windows, windowOk);
  const settings = settingsWithAutoHideTabs(raw.settings, savedWindowRows);
  return {
    windowsAgainstAutoHideTabs: windowsAgainstAutoHideTabs(settings, savedWindowRows),
    profiles: profilesWithOwnLooks(profilesKeepingLegacyDots(byProfile<Profile>(raw.profiles, profileOk), raw.settings)),
    profileOrder: strings(raw.profileOrder).filter(notInherited),
    orphanedProfileData: strings(raw.orphanedProfileData),
    settings,
    settingsMeta: parseSettingsMeta(raw.settingsMeta),
    windows: byId(rows<Omit<BrowserWindow, "autoHideTabs"> & { incognito?: unknown; sidebarOpen?: unknown; autoHideTabs?: unknown }>(raw.windows, windowOk).map(({ incognito: _i, sidebarOpen: _s, autoHideTabs, ...w }): BrowserWindow => ({ ...w, kind: "main", ...(typeof autoHideTabs === "boolean" ? { autoHideTabs } : {}) }))),
    windowOrder: strings(raw.windowOrder).filter(notInherited),
    focusedWindowId: ownId(raw.focusedWindowId),
    lastProfileId: ownId(raw.lastProfileId),
    tabs: byId(rows<Tab>(raw.tabs, tabOk).map((t) => ({ ...t, page: pageFromDisk(t.page), pin: pinFromDisk(t.pin) }))),
    groups: byId(rows(raw.groups, groupOk)),
    splits: byId(rows<SplitView>(raw.splits, splitOk).map((v) => ({ ...v, slots: slotsFromDisk(v.slots)! }))),
    closedTabs: rows(raw.closedTabs, closedTabOk),
    closedWindows: rows<ClosedWindow>(raw.closedWindows, tabListOk).map(splitsChecked).map(withoutSavedTabsShown),
    parkedPins: Object.fromEntries(Object.entries(byProfile<ParkedPins>(raw.parkedPins, parkedOk)).map(([p, park]) => [p, splitsChecked(park)])),
    pinChoices: pinChoicesFromDisk(raw.pinChoices),
    pinSync: byProfile(raw.pinSync),
    topAppsMerged: typeof raw.topAppsMerged === "string" ? raw.topAppsMerged : undefined,
    closedGroups: rows(raw.closedGroups, tabListOk),
    deletedGroups: rows(raw.deletedGroups, tabListOk),
    cleanedTabs: rows(raw.cleanedTabs, closedTabOk),
  };
}

const listed = (value: unknown) => (Array.isArray(value) ? value.length : 0);
const keyed = (value: unknown) => (isFields(value) ? Object.keys(value).length : 0);
const CLOSED_LISTS = ["closedTabs", "closedWindows", "closedGroups", "deletedGroups", "cleanedTabs"] as const;

export const droppedRows = (raw: SavedObject, session: SavedSession) =>
  layoutDrops(session) ||
  listed(raw.windows) > Object.keys(session.windows).length ||
  listed(raw.tabs) > Object.keys(session.tabs).length ||
  listed(raw.groups) > Object.keys(session.groups ?? {}).length ||
  listed(raw.splits) > Object.keys(session.splits ?? {}).length ||
  keyed(raw.profiles) > Object.keys(session.profiles ?? {}).length ||
  keyed(raw.parkedPins) > Object.keys(session.parkedPins ?? {}).length ||
  CLOSED_LISTS.some((key) => (raw[key] !== undefined && !Array.isArray(raw[key])) || listed(raw[key]) > (session[key]?.length ?? 0));
