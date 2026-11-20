import { create } from "zustand";
import type { InterfaceStyleChoice, SchemeChoice } from "../../lib/appearance";
import { appVersion } from "../../platform/appInfo";
import { haptics } from "../app/haptics";
import { blocking, type BlockingCategory, type BlockingState } from "../../platform/blocking";
import { pages } from "../../platform/pages";
import { openExternal, shareText } from "../../platform/system";
import { openPage } from "../browse/store";
import { history } from "../history/store";
import { forgetHiddenHistory } from "../library/store";
import { settled } from "../pages/store";
import { searchEngines } from "../search/omnibox";
import { applySearchEngine } from "../search/store";
import { showToast } from "../toasts/store";
import { clearArchivedTabs, currentTabs, setAutoArchiveInterval } from "../tabs/store";
import type { AutoArchiveInterval } from "../tabs/tabModels";
import { countUsage } from "../telemetry/telemetry";
import { closeSettings } from "./nav";
import type { ColorChoice, NightShadeMode, Preferences, SwipeNavigationMode } from "./preferences";
import { clearSince, exportableUrls, FALLBACK_ENGINES, FILTER_LIST_ADDRESS, pickerEngines, listsUpdateFailed, websiteDataKinds, type ClearChoice, type ClearRange } from "./settingsRules";
import { currentPreferences, setPreference } from "./store";

export type { BlockingState };
export { appVersion };
export type FilterListInfo = BlockingState["lists"][number];

export const useBlocking = create<{ state: BlockingState | null; busy: boolean }>()(() => ({ state: null, busy: false }));

export type AppLinkChoice = "ardia" | "app";

export const useEngines = create<{ engines: { id: string; name: string }[]; nightShade: NightShadeMode; appLinks: AppLinkChoice }>()(() => ({
  engines: [],
  nightShade: "disabled",
  appLinks: "ardia",
}));

const quietly = (call: () => Promise<unknown>) => void settled(call, undefined);

let listening = false;

export function startSettingsSources() {
  if (listening) return;
  listening = true;
  try {
    blocking.addListener((event) => useBlocking.setState({ state: event.state }));
  } catch {
    return;
  }
}

export function setAppLinks(choice: AppLinkChoice) {
  useEngines.setState({ appLinks: choice });
  quietly(() => pages.setAppLinksDefault(choice === "app"));
}

export async function refreshSettings() {
  const [state, shade, engines, opensApps] = await Promise.all([
    settled(() => blocking.state(), null),
    settled(() => pages.nightShade(null, false), null),
    settled(async () => pickerEngines(searchEngines()), [...FALLBACK_ENGINES]),
    settled(() => pages.appLinksDefault(), false),
  ]);
  if (state) useBlocking.setState({ state });
  useEngines.setState({ engines, nightShade: shade?.defaultMode ?? "disabled", appLinks: opensApps ? "app" : "ardia" });
}

export function setSearchEngine(id: string) {
  setPreference("searchEngineId", id);
  applySearchEngine();
}

export const setSearchSuggestions = (on: boolean) => setPreference("searchSuggestions", on);
export const setAutoOpenKeyboard = (on: boolean) => setPreference("autoOpensKeyboard", on);
export const setSwipeNavigation = (mode: SwipeNavigationMode) => setPreference("swipeNavigation", mode);
export const setCollapsesBottomBar = (on: boolean) => setPreference("collapsesBottomBar", on);
export const setColorChoice = (choice: ColorChoice) => setPreference("colorChoice", choice);
export const setDynamicColors = (on: boolean) => setPreference("dynamicColors", on);

export function setMaterialYou(on: boolean) {
  if (currentPreferences().materialYou === on) return;
  setPreference("materialYou", on);
  countUsage(on ? "material_you_turned_on" : "material_you_turned_off");
}
export const setInterfaceStyle = (choice: InterfaceStyleChoice) => setPreference("interfaceStyle", choice);
export const setSchemeChoice = (choice: SchemeChoice) => setPreference("schemeChoice", choice);
export const setArchiveInterval = (interval: AutoArchiveInterval) => setAutoArchiveInterval(interval);

export function setDefaultNightShade(mode: NightShadeMode) {
  setPreference("nightShade", mode);
  useEngines.setState({ nightShade: mode });
  quietly(() => pages.setNightShade(mode, null, false));
}

const withBlocking = (call: () => Promise<unknown>) =>
  quietly(async () => {
    await call();
    const state = await blocking.state();
    useBlocking.setState({ state });
  });

export const setBlockingCategory = (category: BlockingCategory, on: boolean) => withBlocking(() => blocking.setCategory(category, on));
export const setListEnabled = (id: string, on: boolean) => withBlocking(() => blocking.setListEnabled(id, on));
export const removeList = (id: string) => withBlocking(() => blocking.removeList(id));
export const resetLists = () => withBlocking(() => blocking.resetToDefaults());
export const trustSite = (host: string, trusted: boolean) => withBlocking(() => blocking.setEnabledForSite(`https://${host}/`, !trusted, false));

export async function updateLists(): Promise<boolean> {
  useBlocking.setState({ busy: true });
  await settled(() => blocking.updateLists(), undefined);
  const state = await settled(() => blocking.state(), null);
  useBlocking.setState(state ? { state, busy: false } : { busy: false });
  return state === null || listsUpdateFailed(state);
}

export async function updateListsFromButton() {
  if (await updateLists()) haptics.error();
  else haptics.success();
}

const listRefusal = (error: unknown): string =>
  error instanceof Error && (error as { code?: string }).code === "ERR_FILTER_LIST" && error.message ? error.message : FILTER_LIST_ADDRESS.failed;

export async function addList(url: string): Promise<string | null> {
  let refusal: string | null = null;
  try {
    await blocking.addCustomList(url);
  } catch (error) {
    refusal = listRefusal(error);
  }
  const state = await settled(() => blocking.state(), null);
  if (state) useBlocking.setState({ state });
  if (refusal) haptics.error();
  else haptics.success();
  return refusal;
}

export async function applyMyFilters(text: string) {
  const result = await settled(() => blocking.setMyFilters(text), null);
  const state = await settled(() => blocking.state(), null);
  if (state) useBlocking.setState({ state });
  haptics.success();
  return result;
}

export async function clearBrowsingData(choice: ClearChoice, range: ClearRange) {
  if (choice.history) {
    const since = clearSince(range, Date.now());
    history().clear(since);
    forgetHiddenHistory(since);
  }
  const kinds = websiteDataKinds(choice);
  if (kinds.length) await settled(() => pages.clearWebsiteData(kinds, clearSince(range, Date.now())), undefined);
  if (choice.archive && range === "allTime") clearArchivedTabs();
  showToast("Cleared Browsing Data", "checkmark");
}

export const websiteDataClearsByTime = () => pages.clearsWebsiteDataSince();

export function exportOpenTabs() {
  const urls = exportableUrls(currentTabs().open);
  if (!urls.length) {
    showToast("No Open Tabs", "warning");
    return;
  }
  quietly(() => shareText(urls.join("\n"), "Open Tabs from Ardia"));
}

export function openFromSettings(url: string) {
  closeSettings();
  openPage(url, "link");
}

export const openOutside = (url: string) => quietly(() => openExternal(url));
