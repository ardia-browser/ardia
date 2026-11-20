import { addHistoryVisits, deleteHistoryUrls } from "../../platform/history";
import { clearBrowsingData } from "../profiles/profileData";
import type { WebKitExtensionCall } from "../../platform/webkit";
import { storeAction, useBrowser, type BrowserState } from "../browser/store";
import { historyOf } from "../history/history";
import {
  appProfileOf,
  bookmarkIds,
  bookmarkOwnedBy,
  bookmarkTreeRoot,
  chromeBookmark,
  chromeGroupIdOf,
  chromeHistoryItem,
  chromeTabGroup,
  chromeVisitId,
  groupsFor,
  isChromeColor,
  keyFor,
  numberFor,
  tabOfRef,
  windowOfRef,
  type BookmarkIds,
  type ChromeBookmark,
} from "./webKitExtensionData";
import { downloadHandlers } from "./webKitExtensionDownloads";
import { moreHandlers } from "./webKitExtensionMoreApis";

export class ExtensionApiError extends Error {}

const fail = (message: string): never => {
  throw new ExtensionApiError(message);
};

type Handler = (call: WebKitExtensionCall, s: BrowserState) => unknown;
type Options = Record<string, unknown>;

const store = () => useBrowser.getState();
const optionsOf = (value: unknown): Options => (value && typeof value === "object" && !Array.isArray(value) ? (value as Options) : {});
const textOf = (value: unknown) => (typeof value === "string" ? value : "");
const DAY_MS = 86_400_000;

const addBookmark = storeAction("addBookmark");
const addBookmarkFolder = storeAction("addBookmarkFolder");
const updateBookmark = storeAction("updateBookmark");
const moveBookmark = storeAction("moveBookmark");
const removeBookmark = storeAction("removeBookmark");
const updateGroup = storeAction("updateGroup");
const addTabsToGroup = storeAction("addTabsToGroup");
const removeTabsFromGroup = storeAction("removeTabsFromGroup");
const groupTabs = storeAction("groupTabs");

function historyRange(options: Options, now: number) {
  const start = typeof options.startTime === "number" ? options.startTime : now - DAY_MS;
  const end = typeof options.endTime === "number" ? options.endTime : Infinity;
  return { start, end };
}

const history: Record<string, Handler> = {
  search: (call, s) => {
    const options = optionsOf(call.args[0]);
    const { start, end } = historyRange(options, Date.now());
    const text = textOf(options.text).toLowerCase();
    const max = typeof options.maxResults === "number" ? options.maxResults : 100;
    const found = historyOf(s, appProfileOf(s, call.base) ?? "")
      .filter((h) => h.lastVisit >= start && h.lastVisit < end && (!text || h.url.toLowerCase().includes(text) || h.title.toLowerCase().includes(text)))
      .sort((a, b) => b.lastVisit - a.lastVisit);
    return (max > 0 ? found.slice(0, max) : found).map(chromeHistoryItem);
  },
  getVisits: (call, s) => {
    const url = textOf(optionsOf(call.args[0]).url);
    const entry = historyOf(s, appProfileOf(s, call.base) ?? "").find((h) => h.url === url);
    if (!entry) return [];
    const id = String(numberFor("history", url));
    return (entry.visitTimes?.length ? entry.visitTimes : [entry.lastVisit]).map((visitTime) => ({
      id,
      visitId: chromeVisitId(url, visitTime),
      visitTime,
      referringVisitId: "0",
      transition: "link",
      isLocal: true,
    }));
  },
  addUrl: async (call) => {
    const options = optionsOf(call.args[0]);
    const url = textOf(options.url);
    if (!/^(https?|file|ftp):/i.test(url)) fail("Invalid URL.");
    await addHistoryVisits(call.base, [{ url, title: textOf(options.title), visitTimes: [Date.now()] }]);
  },
  deleteUrl: async (call) => void (await deleteHistoryUrls(call.base, [textOf(optionsOf(call.args[0]).url)].filter(Boolean))),
  deleteRange: async (call, s) => {
    const options = optionsOf(call.args[0]);
    if (typeof options.startTime !== "number" || typeof options.endTime !== "number") fail("startTime and endTime are required.");
    const now = Date.now();
    const { start, end } = historyRange(options, now);
    if (end >= now) return void (await clearBrowsingData(call.base, ["history"], start));
    const urls = historyOf(s, appProfileOf(s, call.base) ?? "").filter((h) => h.lastVisit >= start && h.lastVisit < end).map((h) => h.url);
    await deleteHistoryUrls(call.base, urls);
  },
  deleteAll: async (call) => void (await clearBrowsingData(call.base, ["history"])),
};

function bookmarkTarget(s: BrowserState, ids: BookmarkIds, id: unknown): string {
  const key = ids.fromChrome(id);
  if (!key || !s.bookmarks.nodes[key] || !bookmarkOwnedBy(s, ids, key)) fail("Can't find bookmark for id.");
  return key!;
}

const isRootId = (ids: BookmarkIds, key: string) => key === ids.roots.bar || key === ids.roots.other;

function bookmarkSearch(s: BrowserState, ids: BookmarkIds, query: unknown): ChromeBookmark[] {
  const options = typeof query === "string" ? { query } : optionsOf(query);
  const words = textOf(options.query).toLowerCase().split(/\s+/).filter(Boolean);
  const url = typeof options.url === "string" ? options.url : null;
  const title = typeof options.title === "string" ? options.title : null;
  return Object.values(s.bookmarks.nodes)
    .filter((n) => !isRootId(ids, n.id) && bookmarkOwnedBy(s, ids, n.id))
    .filter((n) => {
      const nodeUrl = n.kind === "url" ? n.url : "";
      if (url !== null && nodeUrl !== url) return false;
      if (title !== null && n.title !== title) return false;
      const haystack = `${n.title} ${nodeUrl}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    })
    .map((n) => chromeBookmark(s, ids, n.id, 0)!)
    .filter(Boolean);
}

function writableBookmark(s: BrowserState, ids: BookmarkIds, id: unknown) {
  const key = bookmarkTarget(s, ids, id);
  if (isRootId(ids, key)) fail("Can't modify the root bookmark folders.");
  return key;
}

function insertIndex(s: BrowserState, parentId: string, index: unknown, movingId?: string): number | undefined {
  if (index === undefined) return undefined;
  const parent = s.bookmarks.nodes[parentId];
  const siblings = parent?.kind === "folder" ? parent.children.filter((c) => c !== movingId).length : 0;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > siblings) fail("Index out of bounds.");
  return index as number;
}

function isWithin(s: BrowserState, id: string, ancestorId: string): boolean {
  const seen = new Set<string>();
  for (let at: string | null | undefined = id; at && !seen.has(at); at = s.bookmarks.nodes[at]?.parentId) {
    if (at === ancestorId) return true;
    seen.add(at);
  }
  return false;
}

const bookmarkContext = (call: WebKitExtensionCall, s: BrowserState) => {
  const profileId = appProfileOf(s, call.base);
  if (!profileId) fail("Bookmarks aren't ready.");
  return { profileId: profileId!, ids: bookmarkIds(call.base, s) };
};

const bookmarks: Record<string, Handler> = {
  getTree: (call, s) => [bookmarkTreeRoot(s, bookmarkIds(call.base, s), Infinity)],
  getSubTree: (call, s) => {
    const ids = bookmarkIds(call.base, s);
    if (call.args[0] === "0") return [bookmarkTreeRoot(s, ids, Infinity)];
    return [chromeBookmark(s, ids, bookmarkTarget(s, ids, call.args[0]), Infinity)];
  },
  get: (call, s) => {
    const ids = bookmarkIds(call.base, s);
    const list = Array.isArray(call.args[0]) ? call.args[0] : [call.args[0]];
    return list.map((id) => (id === "0" ? bookmarkTreeRoot(s, ids, 0) : chromeBookmark(s, ids, bookmarkTarget(s, ids, id), 0)));
  },
  getChildren: (call, s) => {
    const ids = bookmarkIds(call.base, s);
    if (call.args[0] === "0") return bookmarkTreeRoot(s, ids, 1).children ?? [];
    return chromeBookmark(s, ids, bookmarkTarget(s, ids, call.args[0]), 1)?.children ?? [];
  },
  getRecent: (call, s) => {
    const ids = bookmarkIds(call.base, s);
    const count = typeof call.args[0] === "number" && call.args[0] > 0 ? call.args[0] : fail("numberOfItems cannot be less than 1.");
    return Object.values(s.bookmarks.nodes)
      .filter((n) => n.kind === "url" && bookmarkOwnedBy(s, ids, n.id))
      .sort((a, b) => b.addedAt - a.addedAt)
      .slice(0, count)
      .map((n) => chromeBookmark(s, ids, n.id, 0));
  },
  search: (call, s) => bookmarkSearch(s, bookmarkIds(call.base, s), call.args[0]),
  create: (call, s) => {
    const { profileId, ids } = bookmarkContext(call, s);
    const options = optionsOf(call.args[0]);
    const parentId = options.parentId === undefined ? ids.roots.other : bookmarkTarget(s, ids, options.parentId);
    if (s.bookmarks.nodes[parentId]?.kind !== "folder") fail("Parent must be a folder.");
    const index = insertIndex(s, parentId, options.index);
    const title = textOf(options.title);
    const id = typeof options.url === "string"
      ? addBookmark({ profileId, url: options.url, title, parentId, index })
      : addBookmarkFolder({ profileId, title, parentId, index });
    return chromeBookmark(store(), ids, id, 0);
  },
  move: (call, s) => {
    const { ids } = bookmarkContext(call, s);
    const key = writableBookmark(s, ids, call.args[0]);
    const destination = optionsOf(call.args[1]);
    const parentId = destination.parentId === undefined ? s.bookmarks.nodes[key]!.parentId! : bookmarkTarget(s, ids, destination.parentId);
    if (s.bookmarks.nodes[parentId]?.kind !== "folder") fail("Parent must be a folder.");
    if (isWithin(s, parentId, key)) fail("Can't move a folder into itself or one of its folders.");
    moveBookmark(key, parentId, insertIndex(s, parentId, destination.index, key));
    return chromeBookmark(store(), ids, key, 0);
  },
  update: (call, s) => {
    const { ids } = bookmarkContext(call, s);
    const key = writableBookmark(s, ids, call.args[0]);
    const changes = optionsOf(call.args[1]);
    if (typeof changes.url === "string" && s.bookmarks.nodes[key]?.kind === "folder") fail("Can't set URL of a bookmark folder.");
    updateBookmark(key, {
      ...(typeof changes.title === "string" ? { title: changes.title } : {}),
      ...(typeof changes.url === "string" ? { url: changes.url } : {}),
    });
    return chromeBookmark(store(), ids, key, 0);
  },
  remove: (call, s) => {
    const { ids } = bookmarkContext(call, s);
    const key = writableBookmark(s, ids, call.args[0]);
    const node = s.bookmarks.nodes[key]!;
    if (node.kind === "folder" && node.children.length) fail("Can't remove non-empty folder (use recursive to force).");
    removeBookmark(key);
  },
  removeTree: (call, s) => {
    const { ids } = bookmarkContext(call, s);
    removeBookmark(writableBookmark(s, ids, call.args[0]));
  },
};

function groupTarget(call: WebKitExtensionCall, s: BrowserState, id: unknown) {
  const list = groupsFor(s, call.profile);
  const key = keyFor("group", id, () => list.map((g) => g.id));
  const group = key ? list.find((g) => g.id === key) : undefined;
  return group ?? fail(`No group with id: ${String(id)}.`);
}

const refsOf = (call: WebKitExtensionCall) => ({ tabKeys: call.tabKeys, windows: call.windows });

const tabsOf = (call: WebKitExtensionCall, value: unknown) =>
  (Array.isArray(value) ? value : [value]).map((ref) => tabOfRef(refsOf(call), ref)).filter((key): key is string => !!key);

const tabGroups: Record<string, Handler> = {
  get: (call, s) => chromeTabGroup(s, groupTarget(call, s, call.args[0])),
  query: (call, s) => {
    const info = optionsOf(call.args[0]);
    const windowId = info.windowId === undefined ? undefined : windowOfRef(s, refsOf(call), info.windowId);
    return groupsFor(s, call.profile)
      .filter((g) => windowId === undefined || g.windowId === windowId)
      .filter((g) => typeof info.collapsed !== "boolean" || g.collapsed === info.collapsed)
      .map((g) => chromeTabGroup(s, g))
      .filter((g) => typeof info.color !== "string" || g.color === info.color)
      .filter((g) => typeof info.title !== "string" || g.title === info.title);
  },
  update: (call, s) => {
    const group = groupTarget(call, s, call.args[0]);
    const changes = optionsOf(call.args[1]);
    updateGroup(group.id, {
      ...(typeof changes.collapsed === "boolean" ? { collapsed: changes.collapsed } : {}),
      ...(typeof changes.title === "string" ? { name: changes.title } : {}),
      ...(isChromeColor(changes.color) ? { color: changes.color } : {}),
    });
    return chromeTabGroup(store(), store().groups[group.id] ?? group);
  },
  move: (call, s) => chromeTabGroup(s, groupTarget(call, s, call.args[0])),
  group: (call, s) => {
    const options = optionsOf(call.args[0]);
    const tabs = tabsOf(call, options.tabIds);
    if (!tabs.length) fail("No tab with the given ids.");
    if (options.groupId !== undefined) {
      const group = groupTarget(call, s, options.groupId);
      addTabsToGroup(group.id, tabs);
      return numberFor("group", group.id);
    }
    const made = groupTabs(tabs, { pinned: false });
    return made ? numberFor("group", made) : fail("These tabs can't be grouped.");
  },
  ungroup: (call) => void removeTabsFromGroup(tabsOf(call, optionsOf(call.args[0]).tabIds)),
  groupIdsOf: (call, s) => call.tabKeys.map((key) => chromeGroupIdOf(s, key)),
};

const handlers: Record<string, Record<string, Handler>> = { downloads: downloadHandlers, history, bookmarks, tabGroups, ...moreHandlers };

export async function answerExtensionCall(call: WebKitExtensionCall): Promise<{ result: unknown } | { error: string }> {
  const group = Object.hasOwn(handlers, call.api) ? handlers[call.api] : undefined;
  const handler = group && Object.hasOwn(group, call.method) ? group[call.method] : undefined;
  if (!handler) return { error: `${call.api}.${call.method} isn't supported.` };
  try {
    const result = await handler(call, store());
    return { result: result === undefined ? null : result };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
