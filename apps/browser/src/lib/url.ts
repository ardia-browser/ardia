import { appUrlOrigin, breadcrumb, displayHost, hostOf, urlForDisplay } from "@ardia/core";

export const withoutFragment = (url: string) => url.replace(/#.*$/, "");

export const withoutUserInfo = (url: string) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, "$1");

export const samePage = (a: string, b: string) => withoutFragment(a).replace(/\/$/, "") === withoutFragment(b).replace(/\/$/, "");

export const isWebPageUrl = (url: string) => /^(https?|file):/i.test(url);

export const displayHostOf = (url: string) => displayHost(hostOf(url));

export const isLocalFileUrl = (url: string) => url.startsWith("file:");

const HOME_FOLDER = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/;
const SHORT_PATH_KEEPS = 2;

function filePathOf(url: string): string {
  const path = decodedOr(url.slice("file://".length).replace(/[?#].*$/, ""));
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

export function shortFilePath(path: string): string {
  const home = path.replace(HOME_FOLDER, "~");
  const parts = home.split("/");
  const root = parts[0] === "" ? "" : parts[0]!;
  const rest = parts.slice(1).filter(Boolean);
  if (rest.length <= SHORT_PATH_KEEPS + 1) return home;
  return [root, "…", ...rest.slice(-SHORT_PATH_KEEPS)].join("/");
}

export const filePathLabel = (url: string) => shortFilePath(filePathOf(url));

export const fullFilePath = (url: string) => filePathOf(url);

export const pageHostLabel = (url: string) => (isLocalFileUrl(url) ? "File" : breadcrumb(url).host);

export function urlTrail(url: string, title: string, { hovered, showFullUrl }: { hovered: boolean; showFullUrl: boolean }): string {
  const isFile = isLocalFileUrl(url);
  const host = pageHostLabel(url);
  const full = isFile ? ` ${decodedOr(url.slice("file://".length))}` : urlForDisplay(url);
  const path = !isFile && full.startsWith(host) ? full.slice(host.length) : full;
  if (hovered) return path;
  if (showFullUrl) return path.replace(/\/$/, "");
  return !/^https?:/i.test(url) && appUrlOrigin(url) && title ? ` / ${title}` : "";
}

function decodedOr(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export const hostOrOrigin = (origin: string) => hostOf(origin) || origin;

export function originForSecurityDisplay(origin: string): string {
  try {
    const url = new URL(origin);
    if (!url.host) return origin;
    return url.protocol === "https:" ? url.host : `${url.protocol}//${url.host}`;
  } catch {
    return origin;
  }
}
