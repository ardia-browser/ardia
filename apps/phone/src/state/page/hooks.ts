import { useShallow } from "zustand/react/shallow";
import { offersDefaultBrowser } from "../settings/settingsRules";
import { launchArguments } from "../app/launchFlags";
import { usePages } from "../pages/store";
import { useDarkScheme } from "../settings/appearance";
import { usePreferences } from "../settings/store";
import { useTabs } from "../tabs/store";
import { menuModel, menuTitle, searchQuery, type MenuModel } from "./pageMenu";
import { usePageUi } from "./store";
import { display } from "../search/omnibox";
import { useDefaultBrowser } from "../settings/defaultBrowser";
import type { Request } from "./pagePrompts";

export const useMenuOpen = () => usePageUi((s) => s.menuOpen);

export const useMenuOpening = () => usePageUi((s) => s.menuOpening);

export const useDrawnMenuOpen = (systemSheet: boolean) => usePageUi((s) => !systemSheet && s.menuOpen);

export const usePageQuiet = (id: string, already: boolean) => usePages((s) => already || s.navigation[id]?.isLoading === false);

export const useTranslationConfirmed = () => usePageUi((s) => s.menuTranslation?.confirmed ?? false);

export const useTranslationAsk = () => usePageUi((s) => s.translationAsk);

export const useMenuPage = () => usePageUi((s) => s.menuPage);
export const useMenuDocked = () => usePageUi((s) => s.menuDocked);
export const useTitleFeedback = () => usePageUi((s) => s.titleFeedback);
export const useFindOpen = () => usePageUi((s) => s.findOpen);
export const useFindQuery = () => usePageUi((s) => s.findQuery);
export const useReaderTabId = () => usePageUi((s) => s.readerTabId);
export const usePress = () => usePageUi((s) => s.press);
export const usePressOpen = () => usePageUi((s) => s.press !== null);

export const usePageBusy = (id: string | null) => usePages((s) => id !== null && (launchArguments().loadFreeze !== null || (s.navigation[id]?.isLoading ?? true)));

export const useFindResult = (id: string | null) => usePages((s) => (id ? s.finds[id] ?? null : null));

export const usePageRequest = (id: string | null) => usePages((s) => (id ? (s.requests[id] as Request | null | undefined) ?? null : null));

const NO_PAGE = { hasPage: false, url: null, canGoBack: false, canGoForward: false, isLoading: false, pageZoom: 1, isDesktopSite: false, blockedRequests: 0 } as const;

export function useMenuModel(id: string): MenuModel {
  const dark = useDarkScheme();
  const state = usePages(
    useShallow((s) => {
      const page = s.navigation[id];
      return page
        ? { hasPage: true, url: page.url, canGoBack: page.canGoBack, canGoForward: page.canGoForward, isLoading: page.isLoading, pageZoom: page.pageZoom, isDesktopSite: page.isDesktopSite, blockedRequests: page.blockedRequests }
        : NO_PAGE;
    }),
  );
  const tabUrl = useTabs((s) => s.open.find((t) => t.id === id)?.url ?? s.privates.find((t) => t.id === id)?.url ?? "");
  const isPrivate = useTabs((s) => s.privates.some((t) => t.id === id));
  const site = usePageUi((s) => s.menuSite);
  const levels = usePageUi((s) => s.zoomLevels);
  const translationLanguageName = usePageUi((s) => s.menuTranslation?.languageName ?? null);
  const browserStatus = useDefaultBrowser((s) => s.status);
  const isDefault = browserStatus?.isDefault ?? false;
  const url = state.url ?? tabUrl;
  return menuModel({
    url,
    hasPage: state.hasPage,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    isLoading: state.isLoading,
    pageZoom: state.pageZoom,
    zoomLevels: levels,
    isDesktopSite: state.isDesktopSite,
    nightShade: site?.nightShade ?? "disabled",
    systemDark: dark,
    blockersEnabled: site?.blockersEnabled ?? true,
    siteKnown: site !== null && site.isPrivate === isPrivate && site.host === (display(url).host || null),
    blockedRequests: state.blockedRequests,
    isDefaultBrowser: isDefault,
    canOfferDefaultBrowser: offersDefaultBrowser(browserStatus),
    translationLanguageName,
  });
}

export function useMenuTitle(id: string): string {
  const tab = useTabs((s) => s.open.find((t) => t.id === id) ?? s.privates.find((t) => t.id === id) ?? null);
  if (!tab) return "";
  return menuTitle(tab.title, tab.url, display(tab.url).host || null, searchQuery(tab.url));
}

export const useReaderSettings = () => ({
  step: usePreferences((p) => p.readerStep),
  serif: usePreferences((p) => p.readerSerif),
  theme: usePreferences((p) => p.readerTheme),
});
