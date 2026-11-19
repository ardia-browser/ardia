import { call, domainModule } from "./engine/call";

export type FaviconImage = { uri: string; width: number; height: number };

type FaviconsModule = { storesIcons?: boolean; token?(profile: string): string | null; saveLaunchIcons?(profile: string, uris: string[]): string[] };

const PNG_DATA_URI = "data:image/png;base64,";
const uriOf = (found: { uri?: string; png?: string }) => found.uri ?? `${PNG_DATA_URI}${found.png}`;
const native = () => domainModule<FaviconsModule>("favicons");
const storesIcons = () => native().storesIcons === true;

export async function faviconsFor(profile: string, pages: string[], icons: string[] = [], size = 32) {
  const result = await call("favicons.get", { profile, pages, icons, size });
  return {
    pages: new Map(Object.entries(result.pages).map(([page, r]) => [page, { uri: uriOf(r), icon: r.icon }])),
    icons: new Map(Object.entries(result.icons).map(([icon, r]) => [icon, uriOf(r)])),
  };
}

export async function storeFavicon(profile: string, page: string, icon: string, png: string): Promise<string> {
  const { uri } = await call("favicons.set", { profile, page, icon, png });
  return uri ?? `${PNG_DATA_URI}${png}`;
}

export const fetchFavicon = (url: string, profile: string, page?: string) => call("favicons.fetch", { profile, url, ...(page && storesIcons() ? { page } : {}) });

export const forgetFavicons = async (profile: string): Promise<void> => {
  if (storesIcons()) await call("favicons.forget", { profile });
};

const STORED_FAVICON = /^ardia-favicon:\/\/icon\/([0-9a-f]{24})\/((?:page|icon)\/[A-Za-z0-9%._~-]+\?v=[0-9a-f]{16})$/;

export const isStoredFavicon = (uri: string) => STORED_FAVICON.test(uri);

export const storedFaviconPath = (uri: string) => STORED_FAVICON.exec(uri)?.[2] ?? null;

export function storedFaviconAt(profile: string, path: string): string | null {
  const token = storesIcons() ? native().token?.(profile) : null;
  const uri = token ? `ardia-favicon://icon/${token}/${path}` : "";
  return isStoredFavicon(uri) ? uri : null;
}

export const saveLaunchFavicons = (profile: string, uris: string[]): string[] => (storesIcons() ? (native().saveLaunchIcons?.(profile, uris) ?? []) : []);
