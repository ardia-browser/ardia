import { appUrlRoute, toAppUrl } from "@ardia/core";
import { fromLegacyUrl } from "../../lib/legacy";
import { appUrlAction } from "../pages/appUrls";

const UNSAFE_RANGES: [number, number][] = [
  [0x0000, 0x0020],
  [0x007f, 0x00a0],
  [0x00ad, 0x00ad],
  [0x1680, 0x1680],
  [0x180e, 0x180e],
  [0x2000, 0x200f],
  [0x2028, 0x202f],
  [0x205f, 0x2064],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
const hasUnsafeCharacter = (url: string) => {
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (UNSAFE_RANGES.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
};
const WEB_URL = /^https?:\/\/[^/?#\\]/i;
const FILE_URL = /^file:\/\//i;
const BLANK_PAGE = /^about:blank$/i;
const ENGINE_PAGES_OPENED_FROM_APPS = new Set(["game", "version"]);
const APP_URL_HOST = /^ardia:\/\/([^/?#]*)/;

function admitAppUrl(given: string): string | null {
  const url = toAppUrl(fromLegacyUrl(given));
  const host = APP_URL_HOST.exec(url)?.[1];
  if (!host) return null;
  const route = appUrlRoute(url);
  if (route?.kind === "page" || route?.kind === "newTab") return url;
  if (route?.kind === "settings") return appUrlAction(url) ? url : null;
  return ENGINE_PAGES_OPENED_FROM_APPS.has(host) ? url : null;
}

export function admitIncomingUrl(given: string): string | null {
  if (!given || hasUnsafeCharacter(given)) return null;
  if (WEB_URL.test(given) || FILE_URL.test(given) || BLANK_PAGE.test(given)) return given;
  return admitAppUrl(given);
}
