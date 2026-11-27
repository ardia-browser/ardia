import { create } from "zustand";

export type SettingsRoute =
  | { page: "root" }
  | { page: "general" }
  | { page: "tabs" }
  | { page: "search" }
  | { page: "experimental" }
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

export const isSettingsOpening = (generation: number) => {
  const state = useSettingsNav.getState();
  return state.open && state.generation === generation;
};

export const rememberSettingsScroll = (page: string, y: number, generation: number) => {
  if (isSettingsOpening(generation)) scrolls.set(page, y);
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

export function closeSettingsFrom(generation: number) {
  if (useSettingsNav.getState().generation === generation) closeSettings();
}

const SIMPLE_PAGES = new Set<SettingsRoute["page"]>(["root", "general", "tabs", "search", "experimental", "appearance", "theme", "searchEngine", "browseForMe", "pageSummary", "siteSettings", "filterLists", "myFilters", "trustedSites", "clearData", "sync", "defaultBrowser", "syncConnect", "syncWords", "syncScan", "about", "licenses", "whatsSent"]);

export const settingsRouteKey = (route: SettingsRoute): string => (route.page === "filterList" ? `filterList:${route.id}` : route.page);

export function settingsRouteFromKey(key: string): SettingsRoute | null {
  if (key.startsWith("filterList:")) return { page: "filterList", id: key.slice("filterList:".length) };
  return SIMPLE_PAGES.has(key as SettingsRoute["page"]) ? ({ page: key } as SettingsRoute) : null;
}

export const settingsPath = (stack: readonly SettingsRoute[]): string[] => stack.slice(1).map(settingsRouteKey);

const LINKED_PAGES: Partial<Record<SettingsRoute["page"], readonly SettingsRoute["page"][]>> = {
  root: ["sync", "general", "tabs", "appearance", "search", "siteSettings", "experimental"],
  general: ["defaultBrowser", "clearData", "whatsSent", "about"],
  appearance: ["theme"],
  search: ["searchEngine"],
  experimental: ["browseForMe"],
  siteSettings: ["filterLists", "trustedSites"],
  filterLists: ["myFilters"],
  sync: ["syncConnect"],
  about: ["licenses"],
};

export function settingsDestinationKeys(stack: readonly SettingsRoute[]): string[] {
  const top = stack[stack.length - 1] ?? { page: "root" as const };
  const linked = (LINKED_PAGES[top.page] ?? []).map((page) => ({ page }) as SettingsRoute).filter(settingsRouteOffered);
  return [...new Set([...settingsPath(stack), ...linked.map(settingsRouteKey)])];
}

export function followSettingsPath(path: readonly string[], generation?: number) {
  const { open, stack, generation: current } = useSettingsNav.getState();
  if (!open || (generation !== undefined && generation !== current)) return;
  const routes = path.map(settingsRouteFromKey).filter((route): route is SettingsRoute => route !== null);
  const next: SettingsRoute[] = [stack[0] ?? { page: "root" }, ...routes];
  if (next.length === stack.length && next.every((route, index) => settingsRouteKey(route) === settingsRouteKey(stack[index]!))) return;
  useSettingsNav.setState({ stack: next, popping: next.length < stack.length });
}
