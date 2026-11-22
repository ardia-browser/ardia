import type { WebKitExtensionCall } from "../../platform/webkit";
import type { BrowserState } from "../browser/store";
import { clearBrowsingData, type BrowsingDataType } from "../profiles/profileData";

export class BrowsingDataApiError extends Error {}

type Handler = (call: WebKitExtensionCall, s: BrowserState) => unknown;
type Options = Record<string, unknown>;

const fail = (message: string): never => {
  throw new BrowsingDataApiError(message);
};

const optionsOf = (value: unknown): Options => (value && typeof value === "object" && !Array.isArray(value) ? (value as Options) : {});

const REMOVABLE = ["appcache", "cache", "cacheStorage", "cookies", "downloads", "fileSystems", "formData", "history", "indexedDB", "localStorage", "passwords", "pluginData", "serviceWorkers", "webSQL"] as const;
type Removable = (typeof REMOVABLE)[number];

const SITE_DATA = new Set<Removable>(["appcache", "cacheStorage", "cookies", "fileSystems", "indexedDB", "localStorage", "serviceWorkers", "webSQL"]);
const SITE_DATA_CLEARED_TOGETHER: readonly Removable[] = ["cacheStorage", "cookies", "fileSystems", "indexedDB", "localStorage", "serviceWorkers"];

export function browsingDataTypes(wanted: Iterable<string>): BrowsingDataType[] {
  const types = new Set<BrowsingDataType>();
  for (const name of wanted) {
    if (name === "history") types.add("history");
    else if (name === "downloads") types.add("downloads");
    else if (name === "cache") types.add("cache");
    else if (SITE_DATA.has(name as Removable)) types.add("siteData");
  }
  return [...types];
}

const listsSites = (value: unknown) => Array.isArray(value) && value.length > 0;

async function removeData(call: WebKitExtensionCall, options: unknown, wanted: Iterable<string>) {
  const { since, origins, excludeOrigins, hostnames } = optionsOf(options);
  if (listsSites(origins) || listsSites(excludeOrigins) || listsSites(hostnames)) fail("Removing data for only some sites isn't supported.");
  const asked = new Set(wanted);
  if ([...asked].some((name) => SITE_DATA.has(name as Removable)) && !SITE_DATA_CLEARED_TOGETHER.every((name) => asked.has(name)))
    fail("Removing only some kinds of site data isn't supported: cookies, local storage, IndexedDB, service workers, cache storage and file systems are removed together.");
  const types = browsingDataTypes(asked);
  if (types.length) await clearBrowsingData(call.base, types, typeof since === "number" && since > 0 ? since : undefined);
}

const capitalized = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

export const browsingData: Record<string, Handler> = {
  settings: () => {
    const shown = REMOVABLE.filter((n) => n !== "appcache" && n !== "webSQL");
    const on = new Set<Removable>(["cache", "cacheStorage", "cookies", "downloads", "fileSystems", "history", "indexedDB", "localStorage", "serviceWorkers"]);
    return {
      dataRemovalPermitted: Object.fromEntries(shown.map((n) => [n, true])),
      dataToRemove: Object.fromEntries(shown.map((n) => [n, on.has(n)])),
      options: { originTypes: { extension: false, protectedWeb: false, unprotectedWeb: true }, since: 0 },
    };
  },
  remove: (call) => removeData(call, call.args[0], Object.entries(optionsOf(call.args[1])).filter(([, on]) => on === true).map(([name]) => name)),
  ...Object.fromEntries(REMOVABLE.map((name) => [`remove${capitalized(name)}`, ((call) => removeData(call, call.args[0], [name])) satisfies Handler])),
};
