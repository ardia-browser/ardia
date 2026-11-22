import { create } from "zustand";

export type SettingsRoute =
  | { page: "root" }
  | { page: "appearance" }
  | { page: "theme" }
  | { page: "searchEngine" }
  | { page: "browseForMe" }
  | { page: "pageSummary" }
  | { page: "siteSettings" }
  | { page: "filterLists" }
  | { page: "filterList"; id: string }
  | { page: "myFilters" }
  | { page: "trustedSites" }
  | { page: "clearData" }
  | { page: "sync" }
  | { page: "defaultBrowser" }
  | { page: "syncConnect" }
  | { page: "syncWords" }
  | { page: "syncScan" }
  | { page: "about" }
  | { page: "licenses" }
  | { page: "whatsSent" };

type SettingsNav = { generation: number; open: boolean; stack: SettingsRoute[]; popping: boolean };

export const useSettingsNav = create<SettingsNav>()(() => ({ generation: 0, open: false, stack: [], popping: false }));

const scrolls = new Map<string, number>();

export const rememberSettingsScroll = (page: string, y: number, generation: number) => {
  const state = useSettingsNav.getState();
  if (state.open && state.generation === generation) scrolls.set(page, y);
};

export const settingsScroll = (page: string) => scrolls.get(page) ?? 0;

const SYNC_PAGES = new Set<SettingsRoute["page"]>(["sync", "syncConnect", "syncWords", "syncScan"]);

let syncPagesOffered: () => boolean = () => true;

export const offerSyncPages = (offered: () => boolean) => {
  syncPagesOffered = offered;
};

let browseForMePageOffered: () => boolean = () => false;

export const offerBrowseForMePage = (offered: () => boolean) => {
  browseForMePageOffered = offered;
};

let pageSummaryPageOffered: () => boolean = () => false;

export const offerPageSummaryPage = (offered: () => boolean) => {
  pageSummaryPageOffered = offered;
};

export const settingsRouteOffered = (route: SettingsRoute) =>
  route.page === "browseForMe" ? browseForMePageOffered() : route.page === "pageSummary" ? pageSummaryPageOffered() : !SYNC_PAGES.has(route.page) || syncPagesOffered();

export function openSettings(route: SettingsRoute = { page: "root" }, { direct = false } = {}) {
  if (!settingsRouteOffered(route)) return;
  scrolls.clear();
  const stack: SettingsRoute[] = direct || route.page === "root" ? [route] : [{ page: "root" }, route];
  useSettingsNav.setState((state) => ({ generation: state.generation + 1, open: true, stack, popping: false }));
}

export function openSettingsPage(route: SettingsRoute) {
  if (!settingsRouteOffered(route)) return;
  scrolls.clear();
  useSettingsNav.setState((state) => ({ generation: state.generation + 1, open: true, stack: [route], popping: false }));
}

export const pushSettings = (route: SettingsRoute) => {
  if (settingsRouteOffered(route)) useSettingsNav.setState((s) => ({ stack: [...s.stack, route], popping: false }));
};

export function popSettings(): boolean {
  const { open, stack } = useSettingsNav.getState();
  if (!open) return false;
  if (stack.length <= 1) closeSettings();
  else useSettingsNav.setState({ stack: stack.slice(0, -1), popping: true });
  return true;
}

export function closeSettings() {
  scrolls.clear();
  useSettingsNav.setState({ open: false, stack: [], popping: false });
}

export const settingsNav = () => useSettingsNav.getState();

const SIMPLE_PAGES = new Set<SettingsRoute["page"]>(["root", "appearance", "theme", "searchEngine", "browseForMe", "pageSummary", "siteSettings", "filterLists", "myFilters", "trustedSites", "clearData", "sync", "defaultBrowser", "syncConnect", "syncWords", "syncScan", "about", "licenses", "whatsSent"]);

export const settingsRouteKey = (route: SettingsRoute): string => (route.page === "filterList" ? `filterList:${route.id}` : route.page);

export function settingsRouteFromKey(key: string): SettingsRoute | null {
  if (key.startsWith("filterList:")) return { page: "filterList", id: key.slice("filterList:".length) };
  return SIMPLE_PAGES.has(key as SettingsRoute["page"]) ? ({ page: key } as SettingsRoute) : null;
}

export const settingsPath = (stack: readonly SettingsRoute[]): string[] => stack.slice(1).map(settingsRouteKey);

export function followSettingsPath(path: readonly string[]) {
  const { open, stack } = useSettingsNav.getState();
  if (!open) return;
  const routes = path.map(settingsRouteFromKey).filter((route): route is SettingsRoute => route !== null);
  const next: SettingsRoute[] = [stack[0] ?? { page: "root" }, ...routes];
  if (next.length === stack.length && next.every((route, index) => settingsRouteKey(route) === settingsRouteKey(stack[index]!))) return;
  useSettingsNav.setState({ stack: next, popping: next.length < stack.length });
}
