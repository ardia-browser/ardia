import { useEffect } from "react";
import { iconTheme, type IconTheme } from "../../platform/favicons";
import { capped, queueFaviconChange, useFavicons } from "./faviconStore";
import { resolveFavicon } from "./favicons";

const theming = new Set<string>();

export function useFaviconTheme(url: string, src?: string | null, profileId?: string): IconTheme | null | undefined {
  const uri = useFavicons(() => resolveFavicon(url, src, profileId)?.uri ?? null);
  const theme = useFavicons((f) => (uri ? f.themes[uri] : undefined));
  const pending = !!uri && theme === undefined;
  useEffect(() => {
    if (!pending || !uri || theming.has(uri)) return;
    theming.add(uri);
    void iconTheme({ uri })
      .catch(() => null)
      .then((found) => queueFaviconChange((f) => (f.themes[uri] === (found ?? null) ? f : { ...f, themes: capped(f.themes, uri, found ?? null) })))
      .finally(() => theming.delete(uri));
  }, [pending, uri]);
  return theme;
}
