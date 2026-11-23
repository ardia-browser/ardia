import { useContext, useEffect } from "react";
import { withoutFragment } from "../../lib/url";
import { keyedWatch, recordWatch, useKeyed, watchWindowRecord } from "../browser/keyedWatch";
import { WindowContext } from "../browser/hooks";
import { useBrowser } from "../browser/store";
import { keysFor, privateViewer } from "./faviconKeys";
import { changedIds } from "../browser/changes";
import type { IconTheme } from "../../platform/favicons";
import { askFaviconTheme, EMPTY_ICONS, lookupOrder, resolveFavicon, useFavicons, watchMissingFavicon, type ResolvedFavicon } from "./favicons";

type Listener = () => void;
type Icons = { pages: Record<string, string | null>; srcs: Record<string, string>; appearances: Record<string, [string, string]> };
type Favicons = { profiles: Record<string, Icons>; themes: Record<string, unknown> };

const KEY_SEPARATOR = "\n";

function indexed(index: Map<string, Map<string, number>>, part: string, key: string, delta: number) {
  let keys = index.get(part);
  if (!keys) index.set(part, (keys = new Map()));
  const count = (keys.get(key) ?? 0) + delta;
  if (count > 0) keys.set(key, count);
  else keys.delete(key);
  if (!keys.size) index.delete(part);
}

function faviconKeyWatches(empty: Icons) {
  const byPage = new Map<string, Map<string, number>>();
  const bySrc = new Map<string, Map<string, number>>();
  const wakeAll = (index: Map<string, Map<string, number>>, part: string, wake: (key: string) => void) => {
    const keys = index.get(part);
    if (keys) for (const key of keys.keys()) wake(key);
  };

  const pages = keyedWatch<Favicons>(
    () => useFavicons,
    (f, prev, wake) => {
      if (f.profiles === prev.profiles || !byPage.size) return;
      for (const id of changedIds(f.profiles, prev.profiles)) {
        const now = f.profiles[id] ?? empty;
        const before = prev.profiles[id] ?? empty;
        for (const page of changedIds(now.pages, before.pages)) wakeAll(byPage, page, wake);
        for (const page of changedIds(now.appearances, before.appearances)) wakeAll(byPage, page, wake);
        for (const src of changedIds(now.srcs, before.srcs)) wakeAll(bySrc, src, wake);
      }
    },
  );

  const watchFaviconPage = (key: string, listener: Listener): (() => void) => {
    const at = key.indexOf(KEY_SEPARATOR);
    const page = key.slice(0, at);
    const src = key.slice(at + 1);
    indexed(byPage, page, key, 1);
    if (src) indexed(bySrc, src, key, 1);
    const off = pages(key, listener);
    return () => {
      off();
      indexed(byPage, page, key, -1);
      if (src) indexed(bySrc, src, key, -1);
    };
  };

  const watchFaviconUri = recordWatch<Favicons, Record<string, unknown>>(() => useFavicons, (f) => f.themes);

  return {
    watchFaviconPage,
    watchFaviconUri,
    pageKey: (url: string, src?: string | null) => (url ? `${withoutFragment(url)}${KEY_SEPARATOR}${src ?? ""}` : null),
  };
}

const { watchFaviconPage, watchFaviconUri, pageKey } = faviconKeyWatches(EMPTY_ICONS);

export function watchFaviconOf(url: string, src: string | null, listener: Listener): () => void {
  const key = pageKey(url, src);
  return key ? watchFaviconPage(key, listener) : () => {};
}

export const watchFaviconTheme = (uri: string, listener: Listener): (() => void) => watchFaviconUri(uri, listener);

export const useResolvedFaviconUri = (url: string, src?: string | null, profileId?: string, source?: string): string | null =>
  useKeyed(watchFaviconPage, pageKey(url, src), () => resolveFavicon(url, src, profileId, source)?.uri ?? null);

function sourceUnanswered(url: string, viewer: string | undefined, source: string | undefined): boolean {
  if (!url || !source || !privateViewer(viewer) || source === viewer) return false;
  const { profiles } = useFavicons.getState();
  return !keysFor(viewer, source).some((key) => profiles[key]?.pages[withoutFragment(url)] !== undefined);
}

export function useFavicon(url: string, src?: string | null, profileId?: string, source?: string): ResolvedFavicon | null {
  const key = useKeyed(watchFaviconPage, pageKey(url, src), () => {
    const found = resolveFavicon(url, src, profileId, source);
    return found ? `${found.profileId} ${found.uri}` : null;
  });
  const waiting = useKeyed(watchFaviconPage, pageKey(url, src), () => sourceUnanswered(url, profileId, source));
  const missing = !!url && (!key || waiting);
  const order = missing ? lookupOrder(profileId, source).join(" ") : "";
  useEffect(() => (missing ? watchMissingFavicon({ url, src, profileId, source }) : undefined), [missing, order, profileId, source, url, src]);
  const split = key?.indexOf(" ") ?? -1;
  return key ? { profileId: key.slice(0, split), uri: key.slice(split + 1) } : null;
}

export function usePrivateViewer(): string | undefined {
  const windowId = useContext(WindowContext) ?? "";
  return useKeyed(watchWindowRecord, windowId, () => privateViewer(useBrowser.getState().windows[windowId]?.profileId));
}

export function useFaviconTheme(url: string, src?: string | null, profileId?: string, source?: string): IconTheme | null | undefined {
  const uri = useResolvedFaviconUri(url, src, profileId, source);
  const theme = useKeyed(watchFaviconUri, uri, () => (uri ? useFavicons.getState().themes[uri] : undefined));
  const pending = !!uri && theme === undefined;
  useEffect(() => {
    if (pending && uri) askFaviconTheme(uri);
  }, [pending, uri]);
  return theme;
}
