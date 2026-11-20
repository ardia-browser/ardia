import type { Download } from "../../platform/downloads";
import type { FolderMediaFile } from "../../platform/files";
import type { HistoryEntry, Profile } from "../browser/types";
import { UI_LOCALE } from "../../lib/uiLocale";
import { dayStart, queryWords, searchText } from "../../lib/textSearch";
import type { MediaKind } from "./library";
import { isOffTheRecordPath } from "./offTheRecordPaths";

export type MediaType = Exclude<MediaKind, "all">;
export type MediaItem = { id: string; media: MediaType; at: number | undefined; download: Download; owners?: readonly string[] };
export type DownloadItem = { id: string; at: number | undefined; download: Download; owners?: readonly string[] };
export type Ownership = { download: (d: Download) => readonly string[] | undefined; file: (file: FolderMediaFile) => readonly string[] | undefined };
export type HistoryItem = HistoryEntry;
export type ProfileItem = { id: string; profile: Profile; tabCount: number; current: boolean };
export type LibraryItems = { media: MediaItem[]; downloads: DownloadItem[]; profiles: ProfileItem[]; history: HistoryItem[] };
export type DayGroup<T> = { key: string; title: string; items: T[] };

const EXTENSIONS: Record<MediaType, readonly string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff", "svg", "ico", "jxl"],
  video: ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "mpg", "mpeg", "3gp", "ogv", "flv"],
  audio: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "aif", "aiff", "wma", "mid", "midi", "caf", "alac"],
};
const TYPE_BY_EXTENSION = new Map(Object.entries(EXTENSIONS).flatMap(([type, list]) => list.map((ext) => [ext, type as MediaType])));
const OPAQUE_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/unknown", "application/x-download", "application/force-download"]);

const extensionOf = (name: string) => {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

export function mediaTypeOf(d: Pick<Download, "mimeType" | "filename" | "path">): MediaType | null {
  const mime = (d.mimeType ?? "").trim().toLowerCase();
  const major = mime.slice(0, mime.indexOf("/"));
  if (major === "image" || major === "video" || major === "audio") return major;
  if (!OPAQUE_MIME_TYPES.has(mime)) return null;
  return TYPE_BY_EXTENSION.get(extensionOf(d.filename || d.path)) ?? null;
}

function uniqueById(downloads: readonly Download[]): Download[] {
  const seen = new Set<string>();
  return downloads.filter((d) => !seen.has(d.id) && !!seen.add(d.id));
}

const FOLDER_ITEM = "file:";

export const folderItemPath = (id: string): string | null => (id.startsWith(FOLDER_ITEM) ? id.slice(FOLDER_ITEM.length) : null);

const folderDownload = (file: FolderMediaFile): Download => ({
  id: FOLDER_ITEM + file.path,
  url: "",
  filename: file.name,
  path: file.path,
  state: "finished",
  paused: false,
  received: file.size,
  total: file.size,
  speed: 0,
  mimeType: "",
  startTime: file.added,
  ...(isOffTheRecordPath(file.path) ? { offTheRecord: true } : {}),
});

const newestFirst = (a: MediaItem, b: MediaItem) => (b.at ?? Number.MAX_VALUE) - (a.at ?? Number.MAX_VALUE);

const owned = <T extends object>(item: T, owners: readonly string[] | undefined): T => (owners ? { ...item, owners } : item);

export function mediaItems(downloads: readonly Download[], kind: MediaKind, files: readonly FolderMediaFile[] = [], ownership?: Ownership): MediaItem[] {
  const items: MediaItem[] = [];
  const downloaded = new Set<string>();
  for (const download of uniqueById(downloads)) {
    if (download.state !== "finished") continue;
    const media = mediaTypeOf(download);
    if (!media) continue;
    if (download.path) downloaded.add(download.path);
    if (kind === "all" || kind === media) items.push(owned({ id: download.id, media, at: download.startTime, download }, ownership?.download(download)));
  }
  for (const file of files) {
    if (downloaded.has(file.path) || (kind !== "all" && kind !== file.kind)) continue;
    downloaded.add(file.path);
    items.push(owned({ id: FOLDER_ITEM + file.path, media: file.kind, at: file.added, download: folderDownload(file) }, ownership?.file(file)));
  }
  return items.sort(newestFirst);
}

export const downloadItems = (downloads: readonly Download[], ownersOf?: (d: Download) => readonly string[] | undefined): DownloadItem[] =>
  uniqueById(downloads)
    .filter((download) => download.state !== "cancelled")
    .map((download) => owned({ id: download.id, at: download.startTime, download }, ownersOf?.(download)));

export function profileItems(order: readonly string[], profiles: Readonly<Record<string, Profile>>, tabCounts: Readonly<Record<string, number>>, currentId: string | null): ProfileItem[] {
  return order.flatMap((id) => {
    const profile = profiles[id];
    return profile ? [{ id, profile, tabCount: tabCounts[id] ?? 0, current: id === currentId }] : [];
  });
}

const searchTexts = new WeakMap<object, string>();

export function searchTextOf(item: MediaItem | DownloadItem | HistoryItem | ProfileItem): string {
  let text = searchTexts.get(item);
  if (text !== undefined) return text;
  if ("download" in item) text = searchText(item.download.filename || extensionOf(item.download.path), item.download.url);
  else if ("profile" in item) text = searchText(item.profile.name);
  else text = searchText(item.title, item.url);
  searchTexts.set(item, text);
  return text;
}

export type ExtraSearchText = (item: object) => string;

export function searchItems<T extends MediaItem | DownloadItem | HistoryItem | ProfileItem>(items: readonly T[], query: string, extra?: ExtraSearchText): readonly T[] {
  const words = queryWords(query);
  if (!words.length) return items;
  if (extra)
    return items.filter((item) => {
      const text = searchTextOf(item);
      const more = extra(item);
      return words.every((w) => text.includes(w) || more.includes(w));
    });
  return items.filter((item) => {
    const text = searchTextOf(item);
    return words.every((w) => text.includes(w));
  });
}

type SearchIndex = { extra: ExtraSearchText | undefined; texts: string[]; built: number };

const searchIndexes = new WeakMap<object, SearchIndex>();

function indexEntry(items: readonly object[], extra: ExtraSearchText | undefined): SearchIndex {
  let index = searchIndexes.get(items);
  if (!index || index.extra !== extra) searchIndexes.set(items, (index = { extra, texts: new Array<string>(items.length), built: 0 }));
  return index;
}

function buildIndex(items: readonly (MediaItem | DownloadItem | HistoryItem | ProfileItem)[], index: SearchIndex, until: number) {
  const { texts, extra } = index;
  for (let i = index.built; i < until; i++) {
    const item = items[i]!;
    const text = searchTextOf(item);
    const more = extra ? extra(item) : "";
    texts[i] = more ? `${text}\n${more}` : text;
  }
  index.built = Math.max(index.built, until);
}

export function searchIndexOf(items: readonly (MediaItem | DownloadItem | HistoryItem | ProfileItem)[], extra?: ExtraSearchText): readonly string[] {
  const index = indexEntry(items, extra);
  if (index.built < items.length) buildIndex(items, index, items.length);
  return index.texts;
}

export type SearchMemo<T> = { source: readonly T[]; query: string; result: readonly T[]; positions: readonly number[] | null; wider: SearchMemo<T> } | null;

const matchesAll = (text: string, words: readonly string[]) => {
  for (const word of words) if (!text.includes(word)) return false;
  return true;
};

export function refinedSearch<T extends MediaItem | DownloadItem | HistoryItem | ProfileItem>(memo: SearchMemo<T>, source: readonly T[], query: string, extra?: ExtraSearchText): SearchMemo<T> & object {
  const words = queryWords(query);
  const normal = words.join(" ");
  let base = memo && memo.source === source ? memo : null;
  while (base && !normal.startsWith(base.query)) base = base.wider;
  if (base && base.query === normal) return base;
  if (!words.length) return { source, query: normal, result: source, positions: null, wider: base };
  const texts = searchIndexOf(source, extra);
  const from = base && base.query !== "" ? base.positions : null;
  const positions: number[] = [];
  if (from) {
    for (const i of from) if (matchesAll(texts[i]!, words)) positions.push(i);
  } else {
    for (let i = 0; i < texts.length; i++) if (matchesAll(texts[i]!, words)) positions.push(i);
  }
  const kept = from ? positions.length === from.length : positions.length === source.length;
  const result = kept ? (from ? base!.result : source) : positions.map((i) => source[i]!);
  return { source, query: normal, result, positions, wider: base };
}

export function primeSearchText(items: readonly (MediaItem | DownloadItem | HistoryItem | ProfileItem)[], sliceMs: number, gapMs: number, extra?: ExtraSearchText): () => void {
  const index = indexEntry(items, extra);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    const until = Date.now() + sliceMs;
    while (index.built < items.length && Date.now() < until) buildIndex(items, index, Math.min(items.length, index.built + 256));
    if (index.built < items.length) timer = setTimeout(run, gapMs);
  };
  if (index.built < items.length) timer = setTimeout(run, gapMs);
  return () => clearTimeout(timer);
}

const derivedLists = new WeakMap<object, Map<string, unknown>>();

export function derivedOf<T>(base: object, key: string, make: () => T): T {
  let byKey = derivedLists.get(base);
  if (!byKey) derivedLists.set(base, (byKey = new Map()));
  if (byKey.has(key)) return byKey.get(key) as T;
  const made = make();
  byKey.set(key, made);
  return made;
}

export const mediaOfKind = (items: readonly MediaItem[], kind: MediaKind): readonly MediaItem[] => (kind === "all" ? items : items.filter((item) => item.media === kind));

const TODAY = "Today";
const YESTERDAY = "Yesterday";
const longDate = new Intl.DateTimeFormat(UI_LOCALE, { weekday: "long", month: "long", day: "numeric" });
const longDateWithYear = new Intl.DateTimeFormat(UI_LOCALE, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

const nextDayStart = (start: number) => {
  const d = new Date(start);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

export function dayTitle(start: number, now: number): string {
  const today = dayStart(now);
  if (start === today) return TODAY;
  if (start === dayStart(today - 1)) return YESTERDAY;
  const sameYear = new Date(start).getFullYear() === new Date(today).getFullYear();
  return (sameYear ? longDate : longDateWithYear).format(start);
}

export const libraryItemTime = (item: { at: number | undefined } | { lastVisit: number }): number | undefined => ("at" in item ? item.at : item.lastVisit);

export function dayGroups<T extends { at: number | undefined } | { lastVisit: number }>(items: readonly T[], now: number, timeOf: (item: T) => number | undefined = libraryItemTime): DayGroup<T>[] {
  const timeAt = (item: T) => {
    const time = timeOf(item);
    return time === undefined || !Number.isFinite(time) ? now : time;
  };
  const byStart = new Map<number, { group: DayGroup<T>; start: number; ordered: boolean; last: number }>();
  const days: { group: DayGroup<T>; start: number; ordered: boolean; last: number }[] = [];
  let from = Infinity;
  let to = -Infinity;
  let day: (typeof days)[number] | undefined;
  for (const item of items) {
    const at = timeAt(item);
    if (!day || at < from || at >= to) {
      from = dayStart(at);
      to = nextDayStart(from);
      day = byStart.get(from);
      if (!day) {
        day = { group: { key: String(from), title: dayTitle(from, now), items: [] }, start: from, ordered: true, last: Infinity };
        byStart.set(from, day);
        days.push(day);
      }
    }
    if (at > day.last) day.ordered = false;
    day.last = at;
    day.group.items.push(item);
  }
  days.sort((a, b) => b.start - a.start);
  for (const d of days) if (!d.ordered) d.group.items.sort((a, b) => timeAt(b) - timeAt(a));
  return days.map((d) => d.group);
}
