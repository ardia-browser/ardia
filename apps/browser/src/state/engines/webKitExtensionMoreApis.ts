import { searchUrlFor } from "@ardia/core";
import { confirm } from "../../platform/dialogs";
import { listExtensions, setExtensionEnabled, uninstallExtension, type InstalledExtension } from "../../platform/extensions";
import { clearBrowsingData, type BrowsingDataType } from "../profiles/profileData";
import type { WebKitExtensionCall } from "../../platform/webkit";
import { activeTabId, privateSession } from "../browser/model";
import { useBrowser, type BrowserState } from "../browser/store";
import type { ClosedGroup, ClosedTab, ClosedWindow, TabSnapshot } from "../browser/types";
import { historyOf } from "../history/history";
import { defaultSearchEngine } from "../settings/settings";
import { focusedWindowOf } from "../windows/ui";
import { appProfileOf, keyFor, numberFor, tabOfRef, windowRef, type WindowRef } from "./webKitExtensionData";

export class MoreApiError extends Error {}

const fail = (message: string): never => {
  throw new MoreApiError(message);
};

type Handler = (call: WebKitExtensionCall, s: BrowserState) => unknown;
type Options = Record<string, unknown>;

const store = () => useBrowser.getState();
const optionsOf = (value: unknown): Options => (value && typeof value === "object" && !Array.isArray(value) ? (value as Options) : {});
const textOf = (value: unknown) => (typeof value === "string" ? value : "");
const isHostPermission = (p: string) => p.includes("://") || p === "<all_urls>" || p.startsWith("*") || p.startsWith("<");

export type ChromeExtensionInfo = {
  description: string;
  enabled: boolean;
  homepageUrl: string;
  hostPermissions: string[];
  id: string;
  installType: "admin" | "development" | "normal" | "sideload" | "other";
  isApp: boolean;
  mayDisable: boolean;
  mayEnable?: boolean;
  disabledReason?: "unknown";
  name: string;
  offlineEnabled: boolean;
  optionsUrl: string;
  permissions: string[];
  shortName: string;
  type: "extension";
  version: string;
  versionName: string;
};

function installTypeOf(x: InstalledExtension): ChromeExtensionInfo["installType"] {
  const location = x.location.toLowerCase();
  if (x.blockedByPolicy || location.includes("policy")) return "admin";
  if (location.includes("unpacked") || location.includes("command")) return "development";
  if (x.fromWebStore || location.includes("internal")) return "normal";
  if (location.includes("external")) return "sideload";
  return "other";
}

const apiPermissionsSeen = new Map<string, string[]>();

export function noteApiPermissions(permissions: Record<string, string[]> | undefined) {
  for (const [id, list] of Object.entries(permissions ?? {})) apiPermissionsSeen.set(id, list);
}

export function chromeExtensionInfo(x: InstalledExtension): ChromeExtensionInfo {
  const info: ChromeExtensionInfo = {
    description: x.description,
    enabled: x.enabled,
    homepageUrl: x.homepageUrl ?? "",
    hostPermissions: [...new Set(x.sites)],
    id: x.id,
    installType: installTypeOf(x),
    isApp: false,
    mayDisable: x.mayModify,
    name: x.name,
    offlineEnabled: false,
    optionsUrl: x.optionsUrl ?? "",
    permissions: [...(apiPermissionsSeen.get(x.id) ?? [])].sort(),
    shortName: x.name,
    type: "extension",
    version: x.version,
    versionName: "",
  };
  if (!x.enabled) {
    info.mayEnable = x.mayModify && !x.blockedByPolicy;
    info.disabledReason = "unknown";
  }
  return info;
}

const WARNINGS: [test: (p: Set<string>, hosts: string[]) => boolean, text: string][] = [
  [(_, hosts) => hosts.some((h) => h === "<all_urls>" || /^\*:\/\/\*\/|^https?:\/\/\*\//.test(h)), "Read and change all your data on all websites"],
  [(p) => p.has("history"), "Read and change your browsing history on all your signed-in devices"],
  [(p) => !p.has("history") && (p.has("tabs") || p.has("webNavigation")), "Read your browsing history"],
  [(p) => !p.has("history") && p.has("topSites"), "Read a list of your most frequently visited websites"],
  [(p) => p.has("bookmarks"), "Read and change your bookmarks"],
  [(p) => p.has("clipboardRead"), "Read data you copy and paste"],
  [(p) => p.has("clipboardWrite"), "Modify data you copy and paste"],
  [(p) => p.has("contentSettings"), "Change your settings that control websites' access to features such as cookies, JavaScript, plugins, geolocation, microphone, camera etc."],
  [(p) => p.has("debugger"), "Access the page debugger backend"],
  [(p) => p.has("declarativeNetRequest"), "Block content on any page"],
  [(p) => p.has("desktopCapture"), "Capture content of your screen"],
  [(p) => p.has("downloads"), "Manage your downloads"],
  [(p) => p.has("geolocation"), "Detect your physical location"],
  [(p) => p.has("management"), "Manage your apps, extensions, and themes"],
  [(p) => p.has("nativeMessaging"), "Communicate with cooperating native applications"],
  [(p) => p.has("notifications"), "Display notifications"],
  [(p) => p.has("pageCapture"), "Read and change all your data on all websites"],
  [(p) => p.has("privacy"), "Change your privacy-related settings"],
  [(p) => p.has("tabGroups"), "View and manage your tab groups"],
  [(p) => p.has("tabCapture"), "Read and change all your data on all websites"],
];

export function permissionWarnings(permissions: readonly string[]): string[] {
  const hosts = permissions.filter(isHostPermission);
  const apis = new Set(permissions.filter((p) => !isHostPermission(p)));
  const warnings = WARNINGS.filter(([test]) => test(apis, hosts)).map(([, text]) => text);
  const broad = warnings.includes(WARNINGS[0]![1]);
  const named = [...new Set(hosts.map((h) => /^[^:]+:\/\/(\*\.)?([^/]+)/.exec(h)?.[2]).filter((h): h is string => !!h && h !== "*"))];
  if (!broad && named.length === 1) warnings.unshift(`Read and change your data on ${named[0]}`);
  else if (!broad && named.length > 1) warnings.unshift(named.length <= 3 ? `Read and change your data on ${named.join(", ")}` : "Read and change your data on a number of websites");
  return [...new Set(warnings)];
}

async function extensionsOf(call: WebKitExtensionCall) {
  return listExtensions(call.base);
}

async function extensionById(call: WebKitExtensionCall, id: unknown) {
  const found = (await extensionsOf(call)).find((x) => x.id === id);
  return found ?? fail(`Failed to find extension with id ${String(id)}.`);
}

const answeredInTime = (call: WebKitExtensionCall) => call.answerBy === undefined || Date.now() <= call.answerBy;

async function uninstall(call: WebKitExtensionCall, id: unknown, askEvenForSelf: boolean) {
  const list = await extensionsOf(call);
  const target = list.find((x) => x.id === id) ?? fail(`Failed to find extension with id ${String(id)}.`);
  if (!target.mayModify) fail(`Extension ${target.id} cannot be modified by user.`);
  const self = target.id === call.extensionId;
  if (!self || askEvenForSelf) {
    const asker = list.find((x) => x.id === call.extensionId)?.name;
    const { confirmed } = await confirm({
      title: `Remove “${target.name}”?`,
      message: self || !asker ? "Its data and settings will be removed too." : `“${asker}” wants to remove it. Its data and settings will be removed too.`,
      confirmTitle: "Remove",
      destructive: true,
      windowId: windowFor(store(), call) ?? undefined,
    });
    if (!confirmed) fail("Extension uninstall canceled by user.");
    if (!answeredInTime(call)) fail("Extension uninstall timed out.");
  }
  await uninstallExtension(target.id, call.base);
}

const management: Record<string, Handler> = {
  getSelf: async (call) => chromeExtensionInfo(await extensionById(call, call.extensionId)),
  get: async (call) => chromeExtensionInfo(await extensionById(call, call.args[0])),
  getAll: async (call) => (await extensionsOf(call)).map(chromeExtensionInfo),
  getPermissionWarningsById: async (call) => {
    const x = await extensionById(call, call.args[0]);
    return [...permissionWarnings(x.siteAccess === "ON_ALL_SITES" ? ["<all_urls>"] : x.sites), ...x.permissions];
  },
  getPermissionWarningsByManifest: (call) => {
    let manifest: Options;
    try {
      manifest = optionsOf(JSON.parse(textOf(call.args[0])));
    } catch {
      return fail("Manifest file is invalid");
    }
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : []);
    return permissionWarnings([...list(manifest.permissions), ...list(manifest.host_permissions)]);
  },
  setEnabled: async (call) => {
    const target = await extensionById(call, call.args[0]);
    const enabling = call.args[1] === true;
    if (target.id === call.extensionId || !target.mayModify || (enabling && target.blockedByPolicy)) fail(`Extension ${target.id} cannot be modified by user.`);
    await setExtensionEnabled(target.id, call.base, enabling);
  },
  uninstall: async (call) => uninstall(call, call.args[0], optionsOf(call.args[1]).showConfirmDialog === true),
  uninstallSelf: async (call) => uninstall(call, call.extensionId, optionsOf(call.args[0]).showConfirmDialog === true),
  launchApp: () => fail("Extension is not an app."),
  createAppShortcut: () => fail("Extension is not an app."),
  setLaunchType: () => fail("Extension is not an app."),
  generateAppForLink: () => fail("The URL is invalid."),
};

const TOP_SITES = 20;

const topSites: Record<string, Handler> = {
  get: (call, s) =>
    historyOf(s, appProfileOf(s, call.base) ?? "")
      .filter((h) => /^https?:/i.test(h.url))
      .sort((a, b) => b.visits - a.visits || b.lastVisit - a.lastVisit)
      .slice(0, TOP_SITES)
      .map((h) => ({ url: h.url, title: h.title })),
};

function windowFor(s: BrowserState, call: WebKitExtensionCall): string | null {
  const profileId = appProfileOf(s, call.base);
  const fits = (id: string | null | undefined) => !!id && !!s.windows[id] && s.windows[id]!.kind !== "private" && s.windows[id]!.profileId === profileId;
  return firstWindow(s, fits);
}

function callerWindowFor(s: BrowserState, call: WebKitExtensionCall): string | null {
  if (!call.private) return windowFor(s, call);
  return firstWindow(s, (id) => !!id && s.windows[id]?.kind === "private" && privateSession(s, s.windows[id]!.profileId) === call.base);
}

function firstWindow(s: BrowserState, fits: (id: string | null | undefined) => boolean): string | null {
  const focused = focusedWindowOf(s);
  if (fits(focused)) return focused;
  return s.windowOrder.find(fits) ?? null;
}

const search: Record<string, Handler> = {
  query: (call, s) => {
    const options = optionsOf(call.args[0]);
    const text = textOf(options.text);
    if (!text) fail("Missing text.");
    if (options.tabId !== undefined && options.disposition !== undefined) fail("Cannot set both 'disposition' and 'tabId'.");
    const url = searchUrlFor(defaultSearchEngine(s.settings).url, text);
    const target = options.tabId !== undefined ? tabOfRef({ tabKeys: call.tabKeys, windows: call.windows }, options.tabId) : null;
    if (options.tabId !== undefined && !target) fail(`No tab with id: ${JSON.stringify(options.tabId)}.`);
    const windowId = callerWindowFor(s, call);
    const disposition = textOf(options.disposition) || "CURRENT_TAB";
    if (target) return void s.navigate(target, url);
    if (call.private && !windowId) fail("No private window to search in.");
    if (disposition === "NEW_WINDOW" && call.private) return void s.newTab(windowId!, { url });
    if (!windowId || disposition === "NEW_WINDOW") return void s.createWindow({ profileId: appProfileOf(s, call.base) ?? undefined, url });
    const current = activeTabId(s, windowId);
    if (disposition === "CURRENT_TAB" && current) return void s.navigate(current, url);
    s.newTab(windowId, { url });
  },
};

export type ChromeSessionTab = {
  index: number;
  windowId: WindowRef | number;
  highlighted: boolean;
  active: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  autoDiscardable: boolean;
  mutedInfo: { muted: boolean };
  incognito: boolean;
  selected: boolean;
  groupId: number;
  url: string;
  title: string;
  favIconUrl?: string;
  sessionId: string;
};

export type ChromeSession = { lastModified: number; tab?: ChromeSessionTab; window?: Record<string, unknown> };

const sessionIdOf = (entryId: string) => String(numberFor("session", entryId));

function sessionTab(s: BrowserState, snapshot: TabSnapshot, entryId: string, index: number, windowId: string | null): ChromeSessionTab {
  return {
    index,
    windowId: windowId && s.windows[windowId] ? windowRef(s, windowId) : -1,
    highlighted: false,
    active: false,
    pinned: !!snapshot.pin,
    audible: false,
    discarded: false,
    autoDiscardable: true,
    mutedInfo: { muted: !!snapshot.muted },
    incognito: false,
    selected: false,
    groupId: -1,
    url: snapshot.url,
    title: snapshot.customTitle || snapshot.title,
    ...(snapshot.favicon ? { favIconUrl: snapshot.favicon } : {}),
    sessionId: sessionIdOf(entryId),
  };
}

type Closed = ClosedTab | ClosedWindow | ClosedGroup;

export function closedEntriesOf(s: BrowserState, profileId: string | null): Closed[] {
  const owned = (p: string | undefined) => !!profileId && p === profileId;
  return [
    ...s.closedTabs.filter((c) => owned(c.tab.profileId)),
    ...s.closedWindows.filter((c) => owned(c.window.profileId)),
    ...s.closedGroups.filter((c) => owned(c.tabs[0]?.profileId)),
  ].sort((a, b) => b.closedAt - a.closedAt);
}

export function chromeSession(s: BrowserState, entry: Closed): ChromeSession {
  const lastModified = Math.floor(entry.closedAt / 1000);
  if (entry.kind === "tab") return { lastModified, tab: sessionTab(s, entry.tab, entry.id, entry.index, entry.windowId) };
  const tabs = entry.tabs.map((t, i) => sessionTab(s, t, `${entry.id}:${i}`, i, null));
  const frame = entry.kind === "window" ? entry.window.frame : undefined;
  return {
    lastModified,
    window: {
      focused: false,
      alwaysOnTop: false,
      incognito: false,
      type: "normal",
      state: "normal",
      ...(frame ? { left: Math.round(frame[0]), top: Math.round(frame[1]), width: Math.round(frame[2]), height: Math.round(frame[3]) } : {}),
      tabs,
      sessionId: sessionIdOf(entry.id),
    },
  };
}

const MAX_SESSIONS = 25;

const sessions: Record<string, Handler> = {
  getRecentlyClosed: (call, s) => {
    const max = optionsOf(call.args[0]).maxResults;
    if (max !== undefined && (typeof max !== "number" || max < 0 || max > MAX_SESSIONS)) fail(`maxResults must be between 0 and ${MAX_SESSIONS}.`);
    return closedEntriesOf(s, appProfileOf(s, call.base))
      .slice(0, typeof max === "number" ? max : MAX_SESSIONS)
      .map((e) => chromeSession(s, e));
  },
  getDevices: () => [],
  restore: (call, s) => {
    const entries = closedEntriesOf(s, appProfileOf(s, call.base));
    const wanted = call.args[0] === undefined || call.args[0] === null ? entries[0] : entries.find((e) => e.id === keyFor("session", call.args[0], () => entries.map((x) => x.id)));
    if (!wanted) fail(call.args[0] == null ? "There are no recently closed sessions." : `Invalid session id: "${String(call.args[0])}".`);
    const before = chromeSession(s, wanted!);
    s.restoreClosed(wanted!.id, windowFor(s, call) ?? undefined);
    return before;
  },
};

const REMOVABLE = ["appcache", "cache", "cacheStorage", "cookies", "downloads", "fileSystems", "formData", "history", "indexedDB", "localStorage", "passwords", "pluginData", "serviceWorkers", "webSQL"] as const;
type Removable = (typeof REMOVABLE)[number];

const SITE_DATA = new Set<Removable>(["appcache", "cacheStorage", "cookies", "fileSystems", "indexedDB", "localStorage", "serviceWorkers", "webSQL"]);
const SITE_DATA_CLEARED_TOGETHER: readonly Removable[] = ["cacheStorage", "cookies", "fileSystems", "indexedDB", "localStorage", "serviceWorkers"];

export function browsingDataTypes(wanted: Iterable<string>): BrowsingDataType[] {
  const types = new Set<BrowsingDataType>();
  for (const name of wanted) {
    if (name === "history") types.add("history");
    else if (name === "downloads") types.add("downloads");
    else if (name === "cache") types.add("cache");
    else if (SITE_DATA.has(name as Removable)) types.add("siteData");
  }
  return [...types];
}

const listsSites = (value: unknown) => Array.isArray(value) && value.length > 0;

async function removeData(call: WebKitExtensionCall, options: unknown, wanted: Iterable<string>) {
  const { since, origins, excludeOrigins, hostnames } = optionsOf(options);
  if (listsSites(origins) || listsSites(excludeOrigins) || listsSites(hostnames)) fail("Removing data for only some sites isn't supported.");
  const asked = new Set(wanted);
  if ([...asked].some((name) => SITE_DATA.has(name as Removable)) && !SITE_DATA_CLEARED_TOGETHER.every((name) => asked.has(name)))
    fail("Removing only some kinds of site data isn't supported: cookies, local storage, IndexedDB, service workers, cache storage and file systems are removed together.");
  const types = browsingDataTypes(asked);
  if (types.length) await clearBrowsingData(call.base, types, typeof since === "number" && since > 0 ? since : undefined);
}

const capitalized = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const browsingData: Record<string, Handler> = {
  settings: () => {
    const shown = REMOVABLE.filter((n) => n !== "appcache" && n !== "webSQL");
    const on = new Set<Removable>(["cache", "cacheStorage", "cookies", "downloads", "fileSystems", "history", "indexedDB", "localStorage", "serviceWorkers"]);
    return {
      dataRemovalPermitted: Object.fromEntries(shown.map((n) => [n, true])),
      dataToRemove: Object.fromEntries(shown.map((n) => [n, on.has(n)])),
      options: { originTypes: { extension: false, protectedWeb: false, unprotectedWeb: true }, since: 0 },
    };
  },
  remove: (call) => removeData(call, call.args[0], Object.entries(optionsOf(call.args[1])).filter(([, on]) => on === true).map(([name]) => name)),
  ...Object.fromEntries(REMOVABLE.map((name) => [`remove${capitalized(name)}`, ((call) => removeData(call, call.args[0], [name])) satisfies Handler])),
};

const runtime: Record<string, Handler> = {
  openOptionsPage: async (call, s) => {
    const ext = await extensionById(call, call.extensionId);
    const url = ext.optionsUrl || fail("Could not create an options page.");
    const profileId = appProfileOf(s, call.base);
    const open = Object.values(s.tabs).find((t) => t.profileId === profileId && t.url === url);
    if (open) return void s.activate(open.id);
    const windowId = windowFor(s, call);
    if (!windowId) return void s.createWindow({ profileId: profileId ?? undefined, url });
    s.newTab(windowId, { url });
  },
};

const withPermissions = (handlers: Record<string, Handler>): Record<string, Handler> =>
  Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      ((call, s) => {
        noteApiPermissions(call.apiPermissions);
        return handler(call, s);
      }) satisfies Handler,
    ]),
  );

export const moreHandlers: Record<string, Record<string, Handler>> = { management: withPermissions(management), topSites, search, sessions, browsingData, runtime };
