import { call } from "./engine/call";

export type FaviconImage = { uri: string; width: number; height: number };

async function lookUpFavicons(name: "favicons.get" | "favicons.peek", profile: string, pages: string[], icons: string[], size: number) {
  const result = await call(name, { profile, pages, icons, size });
  const uri = (png: string) => `data:image/png;base64,${png}`;
  return {
    pages: new Map(Object.entries(result.pages).map(([page, r]) => [page, { uri: uri(r.png), icon: r.icon }])),
    icons: new Map(Object.entries(result.icons).map(([icon, r]) => [icon, uri(r.png)])),
  };
}

export const faviconsFor = (profile: string, pages: string[], icons: string[] = [], size = 32) => lookUpFavicons("favicons.get", profile, pages, icons, size);

export const peekFavicons = (profile: string, pages: string[], icons: string[] = [], size = 32) => lookUpFavicons("favicons.peek", profile, pages, icons, size);

export function storeFavicon(profile: string, page: string, icon: string, png: string) {
  return call("favicons.set", { profile, page, icon, png });
}

export const fetchFavicon = (url: string, profile: string) => call("favicons.fetch", { profile, url });
