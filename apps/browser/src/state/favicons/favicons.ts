import { faviconsFor, fetchFavicon, iconTheme, peekFavicons, storeFavicon, type IconTheme } from "../../platform/favicons";
import { withoutFragment } from "../../lib/url";
import { onHistoryChanged } from "../../platform/history";
import { create } from "zustand";
import { batchStoreUpdates, useBrowser } from "../browser/store";
import { ALL, useKeyed, watchAppDark } from "../browser/keyedWatch";
import { isIncognitoProfile } from "../browser/model";
import { anyBorrowed, askable, askKey, borrowersOf, borrowFor, cacheKey, closeViewers, isBorrowed, keysFor, lookupOrder, settlePeek, sourceEngineOf, viewerOf } from "./faviconKeys";
import { webviews } from "../../platform/webviews";
import { changedPages, pagesWrittenSince, withPages, type PagesPair } from "./pagesWritten";
import { onProfilesOpened, profileOpened } from "../profiles/profileLoading";
import { removeLegacyFiles } from "./legacyFavicons";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { notePageFavicon, notePageFaviconFailed, notePrivateFaviconPeek } from "../telemetry/pageFaviconCounts";
import { fetchFailedBefore, forgetAsked, markAsked, noteFetchFailed, unmarkAsked } from "./askedFavicons";
import { incognitoClosed, takeRequest, unheldBy, unheldIn } from "./privateLookups";

type Icons = {
  pages: Record<string, string | null>;
  srcs: Record<string, string>;
  appearances: Record<string, [string, string]>;
};

export const EMPTY_ICONS: Icons = { pages: {}, srcs: {}, appearances: {} };
const APPEARANCE_SWAP_MS = 5000;
const MAX_ICONS = 3000;
const LOOKUP_DELAY_MS = 16;
const LOOKUP_BATCH = 200;
let appearanceChangedAt = -Infinity;

export type Favicons = {
  profiles: Record<string, Icons>;
  themes: Record<string, IconTheme | null>;
};

export const useFavicons = create<Favicons>()(() => ({ profiles: {}, themes: {} }));

export const knownFaviconTheme = (uri: string) => useFavicons.getState().themes[uri];

export { cacheKey, lookupOrder, privateViewer } from "./faviconKeys";
const siteOf = (url: string) => /^[a-z][\w+.-]*:\/\/[^/?#]*/i.exec(url)?.[0].toLowerCase() ?? "";
export const faviconOutlived = (iconPage: string | null, url: string) => !!iconPage && !!url && siteOf(iconPage) !== siteOf(url);

type Change = (f: Favicons) => Favicons;
const FLUSH_MS = 16;
const changes: Change[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function queue(change: Change, now = false) {
  changes.push(change);
  if (now) flush();
  else flushTimer ??= setTimeout(flush, FLUSH_MS);
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  const all = changes.splice(0);
  if (all.length) batchStoreUpdates(() => useFavicons.setState((f) => all.reduce((s, change) => change(s), f)));
}

function update(key: string, change: (icons: Icons) => Icons, now = false) {
  queue((f) => {
    const before = f.profiles[key] ?? EMPTY_ICONS;
    const after = change(before);
    return after === before ? f : { ...f, profiles: { ...f.profiles, [key]: after } };
  }, now);
}

const capped = <T,>(map: Record<string, T>, key: string, value: T): Record<string, T> =>
  Object.keys(map).length >= MAX_ICONS ? { [key]: value } : { ...map, [key]: value };

let watching = false;

const queued = new Map<string, Set<string>>();
let writeSeq = 0;
const inFlight = new Map<string, { lookups: number; wrote?: number }>();
const wrote = (key: string, page: string) => {
  const pending = inFlight.get(`${key}|${page}`);
  if (pending) pending.wrote = ++writeSeq;
};
let lookupTimer: ReturnType<typeof setTimeout> | undefined;

function ask(key: string, page: string) {
  if (isBorrowed(key) ? !borrowFor(key) : isIncognitoProfile(key)) return;
  if (!markAsked(key, page)) return;
  if (!queued.has(key)) queued.set(key, new Set());
  queued.get(key)!.add(page);
  lookupTimer ??= setTimeout(lookUp, LOOKUP_DELAY_MS);
}

function lookUp() {
  lookupTimer = undefined;
  const batches = [...queued];
  queued.clear();
  for (const [key, pages] of batches) {
    const all = [...pages];
    for (let i = 0; i < all.length; i += LOOKUP_BATCH) lookUpPages(key, all.slice(i, i + LOOKUP_BATCH));
  }
}

function lookUpPages(key: string, list: string[]) {
  const consent = consentToken();
  const pending = list.map((page) => {
    const id = `${key}|${page}`;
    const entry = inFlight.get(id) ?? { lookups: 0 };
    entry.lookups++;
    inFlight.set(id, entry);
    return { id, entry, started: entry.wrote };
  });
  void (isBorrowed(key) ? peekFavicons(sourceEngineOf(key), list) : faviconsFor(key, list))
    .then((found) => {
      if (!settlePeek(key, list, false, () => notePrivateFaviconPeek(false, consent), retryPeek(key))) return;
      update(key, (icons) => {
        const writes: [string, string | null][] = [];
        for (const [i, page] of list.entries()) {
          if (pending[i]!.entry.wrote !== pending[i]!.started) continue;
          const uri = found.pages.get(page)?.uri ?? null;
          if (icons.pages[page] !== uri) writes.push([page, uri]);
        }
        return writes.length ? { ...icons, pages: withPages(icons.pages, writes) } : icons;
      }, true);
    })
    .catch((error) => {
      for (const page of list) unmarkAsked(key, page);
      settlePeek(key, list, true, () => notePrivateFaviconPeek(true, consent), retryPeek(key));
      warnFor(consent, "[favicons] lookup failed", error);
    })
    .finally(() => {
      for (const { id, entry } of pending) if (--entry.lookups === 0) inFlight.delete(id);
    });
}

const retryPeek = (key: string) => (page: string) => void ([...(watchers.get(page) ?? [])].some((w) => w.profileId === viewerOf(key)) && ask(key, page));

const inflight = new Map<string, Promise<string | null>>();

export function noteFavicon(tabId: string, src: string) {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab?.url || !src) return;
  const key = cacheKey(tab.profileId);
  const page = withoutFragment(tab.url);
  const known = useFavicons.getState().profiles[key]?.srcs[src];
  if (known) return remember(key, page, src, known);
  const handle = webviews.get(tabId);
  if (!handle) return;
  const id = `${key}|${src}`;
  let pending = inflight.get(id);
  if (!pending) {
    const consent = consentToken();
    pending = handle.downloadFavicon(src).then((image) => notePageFavicon(image?.uri ?? null, consent), (error) => notePageFaviconFailed(error, consent));
    inflight.set(id, pending);
    void pending.finally(() => inflight.delete(id));
  }
  void pending.then((uri) => uri && remember(key, page, src, uri));
}

function remember(key: string, page: string, src: string, uri: string) {
  const icons = changes.length ? undefined : useFavicons.getState().profiles[key];
  if (icons && icons.pages[page] === uri && icons.srcs[src] === uri) return;
  const dark = useBrowser.getState().ui.appDark;
  const swapped = Date.now() - appearanceChangedAt < APPEARANCE_SWAP_MS;
  wrote(key, page);
  update(key, (icons) => {
    if (incognitoClosed(key)) return icons;
    const previous = icons.pages[page];
    if (previous === uri && icons.srcs[src] === uri) return icons;
    let appearances = icons.appearances;
    if (swapped && previous && previous !== uri) appearances = { ...appearances, [page]: dark ? [previous, uri] : [uri, previous] };
    const startsOver = Object.keys(icons.pages).length >= MAX_ICONS;
    const pages = startsOver ? { [page]: uri } : withPages(icons.pages, [[page, uri]]);
    if (startsOver) forgetAsked(key, pages);
    return { pages, srcs: icons.srcs[src] === uri ? icons.srcs : capped(icons.srcs, src, uri), appearances };
  });
}

type KnownFavicon = { page: string; icon: string; png: string };

const PNG_DATA_URI = "data:image/png;base64,";

export function adoptFavicons(profileId: string, known: KnownFavicon[]) {
  if (isIncognitoProfile(profileId) || !known.length) return;
  const key = cacheKey(profileId);
  const found = new Map(known.map((f) => [withoutFragment(f.page), f]));
  for (const page of found.keys()) wrote(key, page);
  update(key, (icons) => {
    const fresh = [...found].filter(([page]) => !icons.pages[page]);
    if (!fresh.length) return icons;
    const startsOver = Object.keys(icons.pages).length + fresh.length > MAX_ICONS;
    const writes = fresh.map(([page, f]): [string, string] => [page, `${PNG_DATA_URI}${f.png}`]);
    const pages = startsOver ? Object.fromEntries(writes) : withPages(icons.pages, writes);
    if (startsOver) forgetAsked(key, pages);
    return { ...icons, pages };
  }, true);
  void (async () => {
    for (const [page, f] of found) await storeFavicon(key, page, f.icon, f.png).catch(() => null);
  })();
}

function fetchMissing(profileId: string, url: string, src: string) {
  const key = cacheKey(profileId);
  if (isIncognitoProfile(profileId) || !/^https?:/i.test(src) || !profileOpened(key)) return;
  const id = `${key}|${src}`;
  if (inflight.has(id) || fetchFailedBefore(id)) return;
  const pending = fetchFavicon(src, key)
    .then((image) => {
      if (image?.uri.startsWith(PNG_DATA_URI)) void storeFavicon(key, withoutFragment(url), src, image.uri.slice(PNG_DATA_URI.length)).catch(() => null);
      return image?.uri ?? null;
    })
    .catch(() => null);
  inflight.set(id, pending);
  void pending.then((uri) => {
    inflight.delete(id);
    if (uri) remember(key, withoutFragment(url), src, uri);
    else noteFetchFailed(id, MAX_ICONS);
  });
}

export function faviconFailed(profileId: string, uri: string) {
  update(cacheKey(profileId), (icons) => {
    if (!Object.values(icons.pages).includes(uri) && !Object.values(icons.srcs).includes(uri)) return icons;
    return {
      pages: Object.fromEntries(Object.entries(icons.pages).map(([page, u]) => [page, u === uri ? null : u])),
      srcs: Object.fromEntries(Object.entries(icons.srcs).filter(([, u]) => u !== uri)),
      appearances: icons.appearances,
    };
  });
}

export type ResolvedFavicon = { uri: string; profileId: string };

function lookupIn(key: string, url: string, src: string | null | undefined): string | undefined {
  const icons = useFavicons.getState().profiles[key];
  if (!icons) return undefined;
  const page = withoutFragment(url);
  const pair = icons.appearances[page];
  if (pair) return pair[useBrowser.getState().ui.appDark ? 1 : 0];
  return (src ? icons.srcs[src] : undefined) ?? icons.pages[page] ?? undefined;
}

export function resolveFavicon(url: string, src?: string | null, profileId?: string, source?: string): ResolvedFavicon | null {
  if (!url) return null;
  for (const id of lookupOrder(profileId, source))
    for (const key of keysFor(profileId, id)) {
      const uri = lookupIn(key, url, src);
      if (uri) return { uri, profileId: isBorrowed(key) ? key : id };
    }
  return null;
}

export const useAppearanceDark = () => useKeyed(watchAppDark, ALL, () => useBrowser.getState().ui.appDark);

function answered(url: string, profileId?: string, source?: string): boolean {
  const { profiles } = useFavicons.getState();
  const page = withoutFragment(url);
  return lookupOrder(profileId, source).every((id) => !askable(id) || keysFor(profileId, id).some((key) => profiles[key]?.pages[page] !== undefined));
}


type Watcher = { url: string; src?: string | null; profileId?: string; source?: string; known?: boolean };
const watchers = new Map<string, Set<Watcher>>();

function check(w: Watcher) {
  const known = answered(w.url, w.profileId, w.source);
  if (known === w.known) return;
  w.known = known;
  if (!known) {
    for (const id of lookupOrder(w.profileId, w.source)) if (askable(id)) ask(askKey(w.profileId, id), withoutFragment(w.url));
  } else if (w.src && w.profileId && !resolveFavicon(w.url, w.src, w.profileId)) fetchMissing(w.profileId, w.url, w.src);
}


function onFavicons(f: Favicons, prev: Favicons) {
  if (f.profiles === prev.profiles || !watchers.size) return;
  const pairs = changedPages(f, prev);
  if (!pairs.length) return;
  const due = new Set<Set<Watcher>>();
  const unknown: PagesPair[] = [];
  for (const pair of pairs) {
    const written = pair.now && pagesWrittenSince(pair.now, pair.before ?? EMPTY_ICONS.pages);
    if (!written) unknown.push(pair);
    else
      for (const page of written) {
        const set = watchers.get(page);
        if (set) due.add(set);
      }
  }
  if (unknown.length)
    watchers.forEach((set, page) => {
      for (let i = 0; i < unknown.length; i++)
        if (unknown[i]!.now?.[page] !== unknown[i]!.before?.[page]) {
          due.add(set);
          return;
        }
    });
  for (const set of due) for (const w of [...set]) check(w);
}

export function watchMissingFavicon(w: Watcher) {
  if (!watching) {
    watching = true;
    useFavicons.subscribe(onFavicons);
  }
  const page = withoutFragment(w.url);
  let set = watchers.get(page);
  if (!set) watchers.set(page, (set = new Set()));
  set.add(w);
  check(w);
  return () => {
    set.delete(w);
    if (!set.size && watchers.get(page) === set) watchers.delete(page);
  };
}

const theming = new Map<string, symbol>();
const privateIconListeners = new Set<(unheld: (uri: string) => boolean) => void>();

export const faviconHeld = (uri: string) => !unheldIn(useFavicons.getState().profiles)(uri);

export function onPrivateIconsDropped(listener: (unheld: (uri: string) => boolean) => void) {
  privateIconListeners.add(listener);
  return () => void privateIconListeners.delete(listener);
}

export function askFaviconTheme(uri: string) {
  if (theming.has(uri) || !faviconHeld(uri)) return;
  const request = Symbol(uri);
  theming.set(uri, request);
  void iconTheme({ uri })
    .catch(() => null)
    .then((found) => {
      if (!takeRequest(theming, uri, request) || !faviconHeld(uri)) return;
      queue((f) => (f.themes[uri] === (found ?? null) ? f : { ...f, themes: capped(f.themes, uri, found ?? null) }));
    });
}

function forget(key: string) {
  forgetAsked(key);
  for (const [id, pending] of inFlight) if (id.startsWith(`${key}|`)) pending.wrote = ++writeSeq;
  update(key, () => EMPTY_ICONS, true);
}

export function pruneEngineFavicons(engine: string) {
  forget(engine);
  for (const key of borrowersOf(engine)) forget(key);
}

export function startFavicons() {
  removeLegacyFiles(useBrowser.getState(), consentToken());
  const history = onHistoryChanged((change) => {
    if (change.kind !== "deleted") return;
    if (change.all) return pruneEngineFavicons(change.profile);
    const gone = new Set(change.urls.map(withoutFragment));
    for (const key of [change.profile, ...borrowersOf(change.profile)]) {
      for (const page of gone) {
        unmarkAsked(key, page);
        wrote(key, page);
      }
      update(key, (icons) => {
        if (!Object.keys(icons.pages).some((page) => gone.has(page))) return icons;
        return { ...icons, pages: Object.fromEntries(Object.entries(icons.pages).filter(([page]) => !gone.has(page))) };
      });
    }
    for (const page of gone) for (const w of [...(watchers.get(page) ?? [])]) ((w.known = undefined), check(w));
  });
  const opened = onProfilesOpened(() => {
    for (const set of [...watchers.values()])
      for (const w of [...set]) {
        w.known = undefined;
        check(w);
      }
  });
  const stop = useBrowser.subscribeTo(["ui", "windows"], (s, prev) => {
    if (s.ui.appDark !== prev.ui.appDark) appearanceChangedAt = Date.now();
    const before = s.windows === prev.windows ? null : Object.values(prev.windows).map((w) => w.profileId);
    if (before && (changes.length || anyBorrowed() || before.some(isIncognitoProfile) || Object.keys(useFavicons.getState().profiles).some(isIncognitoProfile))) {
      const open = new Set(Object.values(s.windows).map((w) => w.profileId));
      for (const t of Object.values(s.tabs)) open.add(t.profileId);
      for (const key of closeViewers(open)) {
        forgetAsked(key);
        queued.delete(key);
      }
      queue((f) => {
        const gone = Object.keys(f.profiles).filter((id) => isIncognitoProfile(id) && !open.has(viewerOf(id)));
        if (!gone.length) return f;
        const profiles = Object.fromEntries(Object.entries(f.profiles).filter(([id]) => !gone.includes(id)));
        const unheld = unheldBy(Object.values(profiles));
        for (const uri of [...theming.keys()].filter(unheld)) theming.delete(uri);
        for (const listener of privateIconListeners) listener(unheld);
        return { ...f, profiles, themes: Object.fromEntries(Object.entries(f.themes).filter(([uri]) => !unheld(uri))) };
      }, true);
    }
  });
  return () => {
    history.remove();
    opened();
    stop();
  };
}
