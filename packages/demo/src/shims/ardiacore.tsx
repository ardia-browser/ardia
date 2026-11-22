import type { FaviconImage } from "@ardia-real/ardiacore";
import { faviconFor } from "../pages";
import { provideNativeModule } from "./expo-modules-core";

export * from "@ardia-real/ardiacore";
export { devPagerState, pagerState, selectPager, stepPager, SwipeArea, switchPager } from "./web/Pager";
export { WebView } from "./web/WebView";

const ENGINE_ONLY: Record<string, string[]> = {
  ArdiaHistory: ["query", "add", "import", "deleteUrls", "watch"],
  ArdiaBookmarks: ["tree", "apply", "watch"],
  ArdiaFavicons: ["get", "set"],
  ArdiaTabs: ["lastTabPolicy"],
  ArdiaEngine: ["batterySaver", "trimMemory", "openTaskManager", "cliControlStatus", "setCliControl", "setCliActiveTab", "cliTabTargets"],
  ArdiaExtensions: ["watchActions", "syncState", "syncApply"],
  ArdiaDownloads: ["settings", "setSettings"],
};
const DEFAULT_SITE_SETTINGS = {
  camera: { value: "ask", isDefault: true },
  microphone: { value: "ask", isDefault: true },
  location: { value: "ask", isDefault: true },
  notifications: { value: "ask", isDefault: true },
  popups: { value: "block", isDefault: true },
  sound: { value: "allow", isDefault: true },
  autoplay: { value: "allow", isDefault: true },
};
const siteOverrides = new Map<string, Record<string, { value: string; isDefault: boolean }>>();
const allowedHosts = new Set<string>();
let blockerEnabled = true;

const ANSWERS: Record<string, Record<string, unknown>> = {
  ArdiaTabs: { strips: { rev: 0, cmd: null, strips: [] } },
  ArdiaWindows: { list: [] },
  ArdiaExtensions: {
    list: { extensions: [] },
    loadHealth: { dropped: 0, enabled: 0, disabled: {} },
    actionStates: {},
  },
  ArdiaSearch: {
    engines: { list: { engines: [] } },
    suggest: { status: 200, body: "[]" },
  },
  ArdiaSites: {
    origins: [],
    zoomLevels: {},
    preloadPages: false,
    clearData: { cookies: 0, storage: false },
  },
  ArdiaPermissions: {
    externalAppAllowances: [],
  },
  ArdiaContentBlocker: {
    hiddenElements: [],
  },
  ArdiaPasswords: {
    list: { passwords: [] },
    neverSaveOrigins: { origins: [] },
    autofillEnabled: false,
    systemPanelAvailable: { chromium: false, webkit: false },
    otpauthHandler: { app: null },
  },
  ArdiaAutofill: {
    settings: { addresses: false, cards: false },
    addresses: { addresses: [] },
    cards: { cards: [] },
  },
  ArdiaProfiles: {
    loaded: { profiles: [] },
  },
  ArdiaMedia: {
    displayMediaSources: [],
    screenRecordingAllowed: false,
    showCastDialog: false,
  },
};
const HANDLERS: Record<string, Record<string, (profile: string, args: Record<string, unknown>) => unknown>> = {
  ArdiaSites: {
    settings: (profile, args) => {
      const key = `${profile}:${String(args.origin ?? "")}`;
      return { ...DEFAULT_SITE_SETTINGS, ...(siteOverrides.get(key) ?? {}) };
    },
    setSetting: (profile, args) => {
      const key = `${profile}:${String(args.origin ?? "")}`;
      const type = String(args.type ?? "");
      const value = String(args.value ?? "");
      const current = { ...(siteOverrides.get(key) ?? {}) };
      if (value === "default") delete current[type];
      else current[type] = { value, isDefault: false };
      siteOverrides.set(key, current);
      return null;
    },
    reset: (profile, args) => {
      siteOverrides.delete(`${profile}:${String(args.origin ?? "")}`);
      return null;
    },
  },
  ArdiaContentBlocker: {
    state: () => ({
      enabled: blockerEnabled,
      version: "demo",
      lists: [],
      allowedHosts: [...allowedHosts],
      stats: { ready: true, enabled: blockerEnabled, parseMs: 0, lookups: 0, averageLookupMicros: 0, maxLookupMicros: 0 },
    }),
    setEnabled: (_profile, args) => {
      blockerEnabled = Boolean(args.enabled);
      return null;
    },
    isAllowed: (_profile, args) => allowedHosts.has(String(args.host ?? "")),
    setAllowed: (_profile, args) => {
      const host = String(args.host ?? "");
      if (args.allowed) allowedHosts.add(host);
      else allowedHosts.delete(host);
      return null;
    },
  },
};
for (const module of new Set([...Object.keys(ENGINE_ONLY), ...Object.keys(ANSWERS), ...Object.keys(HANDLERS)]))
  provideNativeModule(module, {
    call: async (name: string, profile = "", rawArgs?: string) => {
      if (ENGINE_ONLY[module]?.includes(name)) throw Object.assign(new Error(`${name} is not on the web`), { code: "ERR_ENGINE" });
      const handler = HANDLERS[module]?.[name];
      if (handler) {
        let parsed: Record<string, unknown> = {};
        if (typeof rawArgs === "string" && rawArgs) {
          try {
            parsed = JSON.parse(rawArgs) as Record<string, unknown>;
          } catch {}
        }
        return JSON.stringify(handler(profile, parsed));
      }
      return JSON.stringify(ANSWERS[module]?.[name] ?? null);
    },
  });

export async function faviconsFor(_profile: string, pages: string[], _icons: string[] = []) {
  const found = pages.flatMap((page) => {
    const uri = faviconFor(page);
    return uri ? [[page, { uri, icon: uri }] as const] : [];
  });
  return { pages: new Map(found), icons: new Map<string, string>() };
}

export async function fetchFavicon(url: string, _profile: string, _page?: string): Promise<FaviconImage | null> {
  return { uri: url, width: 32, height: 32 };
}
