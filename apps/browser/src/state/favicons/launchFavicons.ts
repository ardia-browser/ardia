import { isIncognitoProfile } from "../browser/model";
import { cacheKey, EMPTY_ICONS, useFavicons, type Favicons } from "./favicons";
import { withoutFragment } from "../../lib/url";
import { isStoredFavicon, saveLaunchFavicons, storedFaviconAt, storedFaviconPath } from "../../platform/favicons";

export type LaunchFavicons = {
  images: string[];
  profiles: Record<string, { pages: Record<string, number>; srcs: Record<string, number> }>;
  themes: Favicons["themes"];
};

const LAUNCH_ICON_LIMIT = 240;
const LAUNCH_URI_LIMIT = 16 * 1024;
export const LAUNCH_FAVICONS_LIMIT = 1024 * 1024;

const serialized = (value: unknown) => JSON.stringify(value).length + 1;
const saved = (uri: string) => storedFaviconPath(uri) ?? uri;

function chosen(tabs: { url: string; favicon: string | null; profileId: string }[]): LaunchFavicons {
  const { profiles, themes } = useFavicons.getState();
  const look: LaunchFavicons = { images: [], profiles: {}, themes: {} };
  const indexOf = new Map<string, number>();
  let size = serialized(look);
  for (const t of tabs) {
    if (indexOf.size >= LAUNCH_ICON_LIMIT) break;
    if (!t.url || isIncognitoProfile(t.profileId)) continue;
    const key = cacheKey(t.profileId);
    const icons = profiles[key];
    const page = withoutFragment(t.url);
    const uri = icons?.pages[page];
    if (!icons || !uri || uri.length > LAUNCH_URI_LIMIT || look.profiles[key]?.pages[page] !== undefined) continue;
    const fromSrc = t.favicon ? icons.srcs[t.favicon] : undefined;
    const src = t.favicon && fromSrc && fromSrc.length <= LAUNCH_URI_LIMIT ? fromSrc : undefined;
    const fresh = [...new Set([uri, src].filter((u): u is string => !!u && !indexOf.has(u)))];
    const cost =
      (look.profiles[key] ? 0 : serialized(key) + serialized({ pages: {}, srcs: {} })) +
      serialized(page) + 6 +
      (src && t.favicon ? serialized(t.favicon) + 6 : 0) +
      fresh.reduce((sum, u) => sum + serialized(saved(u)) + (themes[u] !== undefined ? serialized(themes[u] ?? null) + 8 : 0), 0);
    if (size + cost > LAUNCH_FAVICONS_LIMIT) continue;
    size += cost;
    for (const u of fresh) {
      indexOf.set(u, look.images.push(u) - 1);
      if (themes[u] !== undefined) look.themes[indexOf.get(u)!] = themes[u] ?? null;
    }
    const entry = (look.profiles[key] ??= { pages: {}, srcs: {} });
    entry.pages[page] = indexOf.get(uri)!;
    if (src && t.favicon) entry.srcs[t.favicon] = indexOf.get(src)!;
  }
  return look;
}

const only = (map: Record<string, number>, keep: (i: number) => boolean) => Object.fromEntries(Object.entries(map).filter(([, i]) => keep(i)));

export function launchFavicons(tabs: { url: string; favicon: string | null; profileId: string }[]): LaunchFavicons {
  const look = chosen(tabs);
  const kept = new Set<string>();
  for (const [key, entry] of Object.entries(look.profiles)) {
    const stored = [...new Set([...Object.values(entry.pages), ...Object.values(entry.srcs)].map((i) => look.images[i]!).filter(isStoredFavicon))];
    for (const uri of stored.length ? saveLaunchFavicons(key, stored) : []) kept.add(uri);
  }
  const shown = (i: number) => !isStoredFavicon(look.images[i]!) || kept.has(look.images[i]!);
  for (const entry of Object.values(look.profiles)) {
    entry.pages = only(entry.pages, shown);
    entry.srcs = only(entry.srcs, shown);
  }
  return { ...look, images: look.images.map((uri, i) => (shown(i) ? saved(uri) : "")) };
}

const restored = (key: string, image: unknown) =>
  typeof image !== "string" || !image ? null : /^(?:page|icon)\//.test(image) ? storedFaviconAt(key, image) : image;

function imagesOf(map: unknown, image: (i: number) => string | null): Record<string, string> {
  if (!map || typeof map !== "object") return {};
  return Object.fromEntries(Object.entries(map).flatMap(([k, i]) => {
    const uri = typeof i === "number" ? image(i) : null;
    return uri ? [[k, uri]] : [];
  }));
}

export function seedFavicons(seed: LaunchFavicons) {
  const images = Array.isArray(seed.images) ? seed.images : [];
  const seeded = Object.entries(seed.profiles ?? {}).filter(([key]) => !isIncognitoProfile(key));
  if (!seeded.length || !images.length) return;
  const savedThemes: Record<string, unknown> = seed.themes && typeof seed.themes === "object" ? seed.themes : {};
  const themes: Favicons["themes"] = {};
  useFavicons.setState((f) => {
    const profiles = { ...f.profiles };
    for (const [key, saved] of seeded) {
      const own = new Map<number, string | null>();
      const image = (i: number) => {
        if (!own.has(i)) own.set(i, restored(key, images[i]));
        const uri = own.get(i)!;
        const theme = savedThemes[i];
        if (uri && theme !== undefined && (theme === null || typeof theme === "object")) themes[uri] = theme as Favicons["themes"][string];
        return uri;
      };
      const icons = profiles[key] ?? EMPTY_ICONS;
      profiles[key] = {
        pages: { ...imagesOf(saved?.pages, image), ...icons.pages },
        srcs: { ...imagesOf(saved?.srcs, image), ...icons.srcs },
        appearances: icons.appearances,
      };
    }
    return { profiles, themes: { ...themes, ...f.themes } };
  });
}
