import { TAB_GROUP_COLORS } from "@ardia/core";
import type { Download } from "../../platform/downloads";
import type { BrowserState } from "../browser/store";
import type { BookmarkNode, HistoryEntry, TabGroup } from "../browser/types";
import { engineProfile } from "../browser/model";
import { rootIdsFor } from "../bookmarks/bookmarks";
import { rootOf } from "../groups/groups";
import { groupOf } from "../pins/tabGrouping";
import { withLiveProgress } from "../downloads/progress";

const numbers = new Map<string, number>();
const keys = new Map<string, string>();

const INT32_IDS = 2 ** 31 - 1;
const WIDE_IDS = 2 ** 52;
const FIRST_ID: Record<string, number> = { bookmark: 3 };
const WIDE_KINDS = new Set(["bookmark", "history", "visit"]);

export function stableHash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function numberFor(kind: string, key: string): number {
  const name = `${kind}\u0000${key}`;
  const known = numbers.get(name);
  if (known !== undefined) return known;
  const first = FIRST_ID[kind] ?? 1;
  const span = (WIDE_KINDS.has(kind) ? WIDE_IDS : INT32_IDS) - first;
  let n = first + (stableHash(name) % span);
  while (keys.has(`${kind}\u0000${n}`)) n = first + ((n - first + 1) % span);
  numbers.set(name, n);
  keys.set(`${kind}\u0000${n}`, key);
  return n;
}

export function adoptChromeNumber(kind: string, key: string, n: number) {
  if (!Number.isSafeInteger(n) || n <= 0 || numbers.has(`${kind}\u0000${key}`)) return false;
  const slot = `${kind}\u0000${n}`;
  const holder = keys.get(slot);
  if (holder !== undefined && holder !== key) return false;
  numbers.set(`${kind}\u0000${key}`, n);
  keys.set(slot, key);
  return true;
}

type ChromeNumbered = { id: string; n?: string; c?: ChromeNumbered[] };

export function adoptChromeBookmarkNumbers(tree: { bar: ChromeNumbered; other: ChromeNumbered }): number {
  let adopted = 0;
  const walk = (node: ChromeNumbered, root: boolean) => {
    if (!root && typeof node.n === "string" && /^\d+$/.test(node.n) && adoptChromeNumber("bookmark", node.id, Number(node.n))) adopted++;
    for (const child of node.c ?? []) walk(child, false);
  };
  walk(tree.bar, true);
  walk(tree.other, true);
  return adopted;
}

export function keyFor(kind: string, n: unknown, candidates?: () => Iterable<string>): string | undefined {
  if (typeof n !== "number" && typeof n !== "string") return undefined;
  if (typeof n === "string" && !/^\d+$/.test(n)) return undefined;
  const name = `${kind}\u0000${Number(n)}`;
  if (!keys.has(name) && candidates) for (const key of candidates()) numberFor(kind, key);
  return keys.get(name);
}

export type WindowRef = { __windowTabs: string[] };

export const windowRef = (s: Pick<BrowserState, "windows">, windowId: string): WindowRef => ({ __windowTabs: [...(s.windows[windowId]?.tabIds ?? [])] });

export type CallRefs = { tabKeys: (string | null)[]; windows: string[][] };

export function tabOfRef(refs: CallRefs, value: unknown): string | null {
  const at = value && typeof value === "object" ? (value as { __tab?: unknown }).__tab : undefined;
  return typeof at === "number" ? (refs.tabKeys[at] ?? null) : null;
}

export function windowOfRef(s: Pick<BrowserState, "tabs">, refs: CallRefs, value: unknown): string | null {
  const at = value && typeof value === "object" ? (value as { __window?: unknown }).__window : undefined;
  if (typeof at !== "number") return null;
  for (const key of refs.windows[at] ?? []) {
    const windowId = s.tabs[key]?.windowId;
    if (windowId) return windowId;
  }
  return null;
}

export const appProfileOf = (s: Pick<BrowserState, "profiles" | "profileOrder">, engine: string) =>
  s.profileOrder.find((id) => engineProfile(s, id) === engine) ?? null;

export type ChromeDownload = {
  id: number;
  url: string;
  finalUrl: string;
  referrer: string;
  filename: string;
  incognito: boolean;
  danger: "safe" | "file";
  mime: string;
  startTime: string;
  endTime?: string;
  state: "in_progress" | "interrupted" | "complete";
  paused: boolean;
  canResume: boolean;
  error?: string;
  bytesReceived: number;
  totalBytes: number;
  fileSize: number;
  exists: boolean;
};

const seenAt = new Map<string, number>();
const endedAt = new Map<string, number>();

export function chromeDownload(d: Download, now = Date.now()): ChromeDownload {
  if (!seenAt.has(d.id)) seenAt.set(d.id, now);
  const done = d.state !== "downloading";
  if (done && !endedAt.has(d.id)) endedAt.set(d.id, now);
  const state = d.state === "finished" ? "complete" : d.state === "downloading" ? "in_progress" : "interrupted";
  return {
    id: numberFor("download", d.id),
    url: d.url,
    finalUrl: d.url,
    referrer: "",
    filename: d.path,
    incognito: !!d.offTheRecord,
    danger: d.dangerous ? "file" : "safe",
    mime: d.mimeType,
    startTime: new Date(seenAt.get(d.id)!).toISOString(),
    ...(done ? { endTime: new Date(endedAt.get(d.id)!).toISOString() } : {}),
    state,
    paused: d.paused,
    canResume: d.state === "downloading" && d.paused,
    ...(d.state === "cancelled" ? { error: "USER_CANCELED" } : d.state === "failed" ? { error: "NETWORK_FAILED" } : {}),
    bytesReceived: d.received,
    totalBytes: d.total > 0 ? d.total : -1,
    fileSize: d.state === "finished" ? d.received : d.total > 0 ? d.total : -1,
    exists: d.state === "finished",
  };
}

export function downloadsFor(s: Pick<BrowserState, "downloads">, profile: string, base: string, isPrivate: boolean): Download[] {
  const listed = s.downloads.filter((d) => {
    const owner = d.profile ?? "";
    if (isPrivate) return owner === profile || (owner === base && !d.offTheRecord);
    return owner === profile && !d.offTheRecord;
  });
  return withLiveProgress(listed);
}

export type ChromeHistoryItem = { id: string; url: string; title: string; lastVisitTime: number; visitCount: number; typedCount: number };

export const chromeVisitId = (url: string, visitTime: number) => String(numberFor("visit", `${url}\u0000${visitTime}`));

export const chromeHistoryItem = (h: HistoryEntry): ChromeHistoryItem => ({
  id: String(numberFor("history", h.url)),
  url: h.url,
  title: h.title,
  lastVisitTime: h.lastVisit,
  visitCount: h.visits,
  typedCount: 0,
});

export type ChromeBookmark = {
  id: string;
  parentId?: string;
  index?: number;
  url?: string;
  title: string;
  dateAdded: number;
  syncing: boolean;
  folderType?: "bookmarks-bar" | "other";
  children?: ChromeBookmark[];
};

export const BOOKMARK_ROOT = "0";
const BAR = "1";
const OTHER = "2";

export type BookmarkIds = { toChrome(id: string): string; fromChrome(id: unknown): string | null; roots: { bar: string; other: string } };

export function bookmarkIds(engine: string, s?: Pick<BrowserState, "bookmarks">): BookmarkIds {
  const roots = rootIdsFor(engine);
  return {
    roots,
    toChrome: (id) => (id === roots.bar ? BAR : id === roots.other ? OTHER : String(numberFor("bookmark", id))),
    fromChrome: (id) => {
      if (typeof id !== "string") return null;
      if (id === BAR) return roots.bar;
      if (id === OTHER) return roots.other;
      if (id === BOOKMARK_ROOT) return null;
      return keyFor("bookmark", id, s ? () => Object.keys(s.bookmarks.nodes) : undefined) ?? null;
    },
  };
}

export function bookmarkOwnedBy(s: Pick<BrowserState, "bookmarks">, ids: BookmarkIds, id: string): boolean {
  let node: BookmarkNode | undefined = s.bookmarks.nodes[id];
  for (let i = 0; node && i < 200; i++) {
    if (node.id === ids.roots.bar || node.id === ids.roots.other) return true;
    node = node.parentId ? s.bookmarks.nodes[node.parentId] : undefined;
  }
  return false;
}

export function chromeBookmark(s: Pick<BrowserState, "bookmarks">, ids: BookmarkIds, id: string, depth: number): ChromeBookmark | null {
  const node = s.bookmarks.nodes[id];
  if (!node) return null;
  const parent = node.parentId ? s.bookmarks.nodes[node.parentId] : undefined;
  const isRoot = id === ids.roots.bar || id === ids.roots.other;
  const out: ChromeBookmark = {
    id: ids.toChrome(id),
    parentId: isRoot ? BOOKMARK_ROOT : parent ? ids.toChrome(parent.id) : BOOKMARK_ROOT,
    index: isRoot ? (id === ids.roots.bar ? 0 : 1) : parent?.kind === "folder" ? Math.max(0, parent.children.indexOf(id)) : 0,
    title: node.title,
    dateAdded: node.addedAt,
    syncing: false,
  };
  if (isRoot) out.folderType = id === ids.roots.bar ? "bookmarks-bar" : "other";
  if (node.kind === "url") out.url = node.url;
  else if (depth > 0) out.children = node.children.map((c) => chromeBookmark(s, ids, c, depth - 1)).filter((c): c is ChromeBookmark => !!c);
  return out;
}

export function bookmarkTreeRoot(s: Pick<BrowserState, "bookmarks">, ids: BookmarkIds, depth: number): ChromeBookmark {
  const children = depth > 0 ? [ids.roots.bar, ids.roots.other].map((id) => chromeBookmark(s, ids, id, depth - 1)).filter((c): c is ChromeBookmark => !!c) : undefined;
  return { id: BOOKMARK_ROOT, title: "", dateAdded: 0, syncing: false, ...(children ? { children } : {}) };
}

export type ChromeTabGroup = { id: number; collapsed: boolean; color: string; title: string; windowId: WindowRef; shared: boolean };

const CHROME_COLORS = new Set<string>(TAB_GROUP_COLORS);

export const chromeColorOf = (color: TabGroup["color"]) => (color && CHROME_COLORS.has(color) ? color : "grey");

export const isChromeColor = (color: unknown): color is (typeof TAB_GROUP_COLORS)[number] => typeof color === "string" && CHROME_COLORS.has(color);

export function groupsFor(s: Pick<BrowserState, "groups" | "profiles">, profile: string): TabGroup[] {
  return Object.values(s.groups).filter((g) => !g.parentId && !g.pinned && engineProfile(s, g.profileId) === profile);
}

export const chromeTabGroup = (s: Pick<BrowserState, "windows">, g: TabGroup): ChromeTabGroup => ({
  id: numberFor("group", g.id),
  collapsed: g.collapsed,
  color: chromeColorOf(g.color),
  title: g.name,
  windowId: windowRef(s, g.windowId),
  shared: false,
});

export function chromeGroupIdOf(s: Pick<BrowserState, "groups">, tabKey: string | null): number {
  const inner = tabKey ? groupOf(s, tabKey) : undefined;
  const root = inner && rootOf(s.groups, inner.id);
  return root && !root.pinned ? numberFor("group", root.id) : -1;
}
