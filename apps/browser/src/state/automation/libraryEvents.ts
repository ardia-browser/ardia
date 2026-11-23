import { onHistoryChanged } from "../../platform/history";
import type { Download } from "../../platform/downloads";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile, isIncognitoProfile } from "../browser/model";
import { changedIds } from "../browser/changes";
import type { BookmarkNode } from "../browser/types";
import { bookmarkRoots } from "../bookmarks/bookmarks";
import { downloadSession } from "../downloads/downloadsSlice";
import { awaitsKeep } from "../downloads/status";
import type { EventSend } from "./storeEvents";
import { DROPPED_MARKER_ROOM, frameBytes } from "./socketWire";

export const LIBRARY_EVENTS = ["bookmarks.changed", "history.removed", "download.changed", "profile.changed"] as const;

const MAX_IDS = 1000;

export const HISTORY_EVENT_LINE_BYTES = 256 * 1024;

const TIME_DIGITS_ROOM = 20;

const capped = (ids: readonly string[]) => (ids.length > MAX_IDS ? ids.slice(0, MAX_IDS) : [...ids]);

const jsonBytes = (value: unknown) => frameBytes(JSON.stringify(value)) - 1;

export function historyRemoval(profiles: string[], all: boolean, urls: readonly string[]) {
  const envelope = { event: "history.removed", time: 0, data: { profiles, all, count: urls.length, urls: [] as string[], truncated: false } };
  let bytes = frameBytes(JSON.stringify(envelope)) + TIME_DIGITS_ROOM + DROPPED_MARKER_ROOM;
  const kept: string[] = [];
  for (const url of urls) {
    const size = jsonBytes(url) + (kept.length ? 1 : 0);
    if (kept.length >= MAX_IDS || bytes + size > HISTORY_EVENT_LINE_BYTES) break;
    kept.push(url);
    bytes += size;
  }
  return { profiles, all, count: urls.length, urls: kept, truncated: kept.length < urls.length };
}

const sameBookmark = (a: BookmarkNode, b: BookmarkNode) =>
  a.kind === b.kind && a.title === b.title && a.parentId === b.parentId && (a.kind === "url" ? a.url === (b as typeof a).url : a.children === (b as typeof a).children || a.children.join() === (b as typeof a).children.join());

function bookmarksLoaded(s: BrowserState, profileId: string) {
  const roots = bookmarkRoots(s, profileId);
  return !!roots && !!s.bookmarks.nodes[roots.bar];
}

const BOOKMARK_DEPTH = 64;

function ownersOfBookmark(s: BrowserState, id: string): string[] {
  let node = s.bookmarks.nodes[id];
  for (let i = 0; node?.parentId && i < BOOKMARK_DEPTH; i++) node = s.bookmarks.nodes[node.parentId];
  if (!node) return [];
  const rootId = node.id;
  return s.profileOrder.filter((p) => {
    const roots = bookmarkRoots(s, p);
    return roots?.bar === rootId || roots?.other === rootId;
  });
}

function bookmarkChanges(s: BrowserState, prev: BrowserState) {
  const byProfile = new Map<string, { added: string[]; changed: string[]; removed: string[] }>();
  for (const id of changedIds(s.bookmarks.nodes, prev.bookmarks.nodes)) {
    const next = s.bookmarks.nodes[id];
    const was = prev.bookmarks.nodes[id];
    if (next && was && sameBookmark(next, was)) continue;
    for (const owner of next ? ownersOfBookmark(s, id) : ownersOfBookmark(prev, id)) {
      if (isIncognitoProfile(owner) || (!was && !bookmarksLoaded(prev, owner))) continue;
      let bucket = byProfile.get(owner);
      if (!bucket) byProfile.set(owner, (bucket = { added: [], changed: [], removed: [] }));
      bucket[!was ? "added" : !next ? "removed" : "changed"].push(id);
    }
  }
  return [...byProfile].map(([profile, b]) => ({ profile, count: b.added.length + b.changed.length + b.removed.length, added: capped(b.added), changed: capped(b.changed), removed: capped(b.removed) }));
}

const downloadData = (d: Download, change: "added" | "updated" | "removed") => ({
  id: d.id,
  change,
  state: d.state,
  paused: d.paused,
  dangerous: !!d.dangerous,
  awaitsKeep: awaitsKeep(d),
  filename: d.filename,
  profile: d.profile ?? "",
});

const sameDownload = (a: Download, b: Download) => a.state === b.state && a.paused === b.paused && !!a.dangerous === !!b.dangerous && awaitsKeep(a) === awaitsKeep(b) && a.filename === b.filename && a.path === b.path;

function downloadChanges(s: BrowserState, prev: BrowserState) {
  const own = (state: BrowserState) => new Map(state.downloads.filter((d) => downloadSession(state, d) === null).map((d) => [d.id, d]));
  const next = own(s);
  const was = own(prev);
  const out: ReturnType<typeof downloadData>[] = [];
  for (const [id, d] of next) {
    const before = was.get(id);
    if (!before) out.push(downloadData(d, "added"));
    else if (!sameDownload(d, before)) out.push(downloadData(d, "updated"));
  }
  for (const [id, d] of was) if (!next.has(id)) out.push(downloadData(d, "removed"));
  return out;
}

const PROFILE_KEYS = ["name", "color", "icon", "theme", "dataId", "pinnedCollapsed", "shareTopApps", "syncTabs"] as const;

function profileChanges(s: BrowserState, prev: BrowserState) {
  const out: Record<string, unknown>[] = [];
  for (const id of changedIds(s.profiles, prev.profiles)) {
    if (isIncognitoProfile(id)) continue;
    const next = s.profiles[id];
    const was = prev.profiles[id];
    if (!was) out.push({ profile: id, change: "created", name: next!.name });
    else if (!next) out.push({ profile: id, change: "removed", name: was.name });
    else {
      const keys = PROFILE_KEYS.filter((k) => JSON.stringify(next[k] ?? null) !== JSON.stringify(was[k] ?? null));
      if (keys.length) out.push({ profile: id, change: "updated", name: next.name, keys });
    }
  }
  const defaultWas = prev.settings.defaultProfileId;
  const defaultNow = s.settings.defaultProfileId;
  if (defaultNow !== defaultWas && s.profiles[defaultNow]) out.push({ profile: defaultNow, change: "updated", name: s.profiles[defaultNow]!.name, keys: ["default"] });
  const order = (state: BrowserState) => state.profileOrder.filter((id) => !isIncognitoProfile(id) && state.profiles[id]);
  if (s.profileOrder !== prev.profileOrder) {
    const now = order(s);
    const before = order(prev).filter((id) => now.includes(id));
    if (before.join() !== now.filter((id) => before.includes(id)).join()) out.push({ change: "reordered", order: now });
  }
  return out;
}

function startHistoryRemovals(send: EventSend) {
  const subscription = onHistoryChanged((change) => {
    if (change.kind !== "deleted") return;
    const s = useBrowser.getState();
    const profiles = s.profileOrder.filter((id) => !isIncognitoProfile(id) && s.profiles[id] && engineProfile(s, id) === change.profile);
    if (!profiles.length) return;
    send("history.removed", historyRemoval(profiles, change.all, change.urls));
  });
  return () => subscription.remove();
}

export function startLibraryEvents(send: EventSend, wants: ReadonlySet<string>): () => void {
  const stops: (() => void)[] = [];
  if (wants.has("history.removed")) stops.push(startHistoryRemovals(send));
  const store = ["bookmarks.changed", "download.changed", "profile.changed"].filter((name) => wants.has(name));
  if (store.length) {
    stops.push(
      useBrowser.subscribe((s, prev) => {
        if (wants.has("bookmarks.changed") && s.bookmarks !== prev.bookmarks) for (const data of bookmarkChanges(s, prev)) send("bookmarks.changed", data);
        if (wants.has("download.changed") && s.downloads !== prev.downloads) for (const data of downloadChanges(s, prev)) send("download.changed", data);
        if (wants.has("profile.changed") && (s.profiles !== prev.profiles || s.profileOrder !== prev.profileOrder || s.settings.defaultProfileId !== prev.settings.defaultProfileId)) {
          for (const data of profileChanges(s, prev)) send("profile.changed", data);
        }
      }),
    );
  }
  return () => stops.forEach((stop) => stop());
}
