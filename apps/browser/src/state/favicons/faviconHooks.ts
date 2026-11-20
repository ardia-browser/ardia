import { useEffect } from "react";
import { withoutFragment } from "../../lib/url";
import { useKeyed } from "../browser/keyedWatch";
import type { IconTheme } from "../../platform/favicons";
import { askFaviconTheme, EMPTY_ICONS, lookupOrder, resolveFavicon, useFavicons, watchMissingFavicon, type ResolvedFavicon } from "./favicons";

type Listener = () => void;
type Icons = { pages: Record<string, string | null>; srcs: Record<string, string>; appearances: Record<string, [string, string]> };
type Favicons = { profiles: Record<string, Icons>; themes: Record<string, unknown> };

const KEY_SEPARATOR = "\n";

function faviconKeyWatches(empty: Icons) {
  const pageWatchers = new Map<string, Set<Listener>>();
  const uriWatchers = new Map<string, Set<Listener>>();
  let hearing = false;

  const hear = (f: Favicons, prev: Favicons) => {
    const woken = new Set<Listener>();
    if (f.themes !== prev.themes) for (const [uri, set] of uriWatchers) if (f.themes[uri] !== prev.themes[uri]) for (const listener of set) woken.add(listener);
    if (f.profiles !== prev.profiles && pageWatchers.size) {
      const changed: [Icons, Icons][] = [];
      for (const id of new Set([...Object.keys(f.profiles), ...Object.keys(prev.profiles)])) {
        const now = f.profiles[id] ?? empty;
        const before = prev.profiles[id] ?? empty;
        if (now !== before) changed.push([now, before]);
      }
      for (const [key, set] of pageWatchers) {
        const at = key.indexOf(KEY_SEPARATOR);
        const page = key.slice(0, at);
        const src = key.slice(at + 1);
        if (changed.some(([now, before]) => now.pages[page] !== before.pages[page] || now.appearances[page] !== before.appearances[page] || (!!src && now.srcs[src] !== before.srcs[src])))
          for (const listener of set) woken.add(listener);
      }
    }
    for (const listener of woken) listener();
  };

  const watchKeysIn =
    (watchers: Map<string, Set<Listener>>) =>
    (key: string, listener: Listener): (() => void) => {
      if (!hearing) {
        hearing = true;
        useFavicons.subscribe(hear);
      }
      let set = watchers.get(key);
      if (!set) watchers.set(key, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size && watchers.get(key) === set) watchers.delete(key);
      };
    };

  return {
    watchFaviconPage: watchKeysIn(pageWatchers),
    watchFaviconUri: watchKeysIn(uriWatchers),
    pageKey: (url: string, src?: string | null) => (url ? `${withoutFragment(url)}${KEY_SEPARATOR}${src ?? ""}` : null),
  };
}

const { watchFaviconPage, watchFaviconUri, pageKey } = faviconKeyWatches(EMPTY_ICONS);

export const useResolvedFaviconUri = (url: string, src?: string | null, profileId?: string): string | null =>
  useKeyed(watchFaviconPage, pageKey(url, src), () => resolveFavicon(url, src, profileId)?.uri ?? null);

export function useFavicon(url: string, src?: string | null, profileId?: string): ResolvedFavicon | null {
  const key = useKeyed(watchFaviconPage, pageKey(url, src), () => {
    const found = resolveFavicon(url, src, profileId);
    return found ? `${found.profileId} ${found.uri}` : null;
  });
  const missing = !!url && !key;
  const order = missing ? lookupOrder(profileId).join(" ") : "";
  useEffect(() => (missing ? watchMissingFavicon({ url, src, profileId }) : undefined), [missing, order, profileId, url, src]);
  const split = key?.indexOf(" ") ?? -1;
  return key ? { profileId: key.slice(0, split), uri: key.slice(split + 1) } : null;
}

export function useFaviconTheme(url: string, src?: string | null, profileId?: string): IconTheme | null | undefined {
  const uri = useResolvedFaviconUri(url, src, profileId);
  const theme = useKeyed(watchFaviconUri, uri, () => (uri ? useFavicons.getState().themes[uri] : undefined));
  const pending = !!uri && theme === undefined;
  useEffect(() => {
    if (pending && uri) askFaviconTheme(uri);
  }, [pending, uri]);
  return theme;
}
