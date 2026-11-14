import type { SettingKey } from "./settings";

export const CONFIG_SETTING_KEYS: readonly SettingKey[] = [
  "warnBeforeQuitting", "warnBeforeClosingWindow", "restoreSession", "searchEngine", "searchSuggestions", "commandBarHistory", "showSelectionSearch",
  "commandBarPreference", "tabLayout", "autoHideTabs", "revealTabsOnHover", "sidebarSide", "hideToolbarWhileScrolling", "newTabPosition", "newTabButtonPosition", "appLinksFirst", "newTabOpens", "reuseEmptyNewTab",
  "warnBeforeClosingLastTab", "undoReopensClosedTab", "warnBeforeMovingTabsToProfile", "shareTabsAcrossWindows", "tabReorderHaptics",
  "extendWebsiteColor", "cmdClickCreatesTabGroup", "optShiftClickOpensInGroup", "dragToGroupInTopStrip", "peekModifier", "peekLinksToOtherSites", "newTabLinksOpenIn", "peekButtons",
  "splitLinkModifier", "autoGroupMeetingTabs", "cleanUpInactiveTabsAfterMinutes", "suggestCleanUp", "mutedSites", "showUnreadCounts", "showTopAppBadges", "showTabHoverMenu", "closedTopAppTiles", "unreadHiddenSites", "neverTranslateSites", "showTranslateButton",
  "autoPictureInPicture", "blockAutoplayEverywhere", "commandScrollZoom", "videoUpscaling", "sidebarMediaControls", "sidebarWidth", "showSidebarButton",
  "showClearButton", "tidyTabs", "balancedTopApps", "showAdvancedSettings", "selectedTabGlow", "sidebarTextSize", "sidebarTextContrast", "selectedTopApp", "elementOutlines", "interfaceStyle", "glassTintWithTheme",
  "glassTintAmount", "pageScrollBars", "fadeUnloadedTabs", "strikeSleepingTabs", "warnBeforeClosingTabGroup", "batterySaverWhen", "memorySaver",
  "memorySaverMode", "loadProfilesWhenOpened", "unloadProfilesAfter", "keepActiveSites", "extensionSidePanelWidth", "showFullUrl", "showBookmarks", "bookmarksBar", "bookmarksBarSize",
  "hideBookmarksBarImport", "appearance", "addressBar", "compactToolbar", "addressBarButtons", "borderlessMode", "tabCornerRadius", "minimalismMode", "pageFrame", "pageFrameZeroInFullScreen", "pageFrameZeroWhenTabsHidden", "commandBarPlacement", "spacesFollowAppearance", "adaptTextToColor",
  "profileSwitcherIcons", "compactCliPill", "shortcuts", "openLinksInLittleArdia", "littleArdiaOpensNewTabLinks", "littleWindowGestures", "littleArdiaSize",
  "omniboxProviders", "launchActions", "commandBarStart", "readerTextSize", "readerFont",
];

export const CONFIG_EXCLUDED_KEYS: readonly SettingKey[] = [
  "customSearchUrl", "newTabUrl", "customSearchEngines", "extensionSearchEngines", "allowJavaScriptFromAppleEvents", "cliControl", "defaultProfileId",
  "pageEngine", "websiteEngines", "protectedVideoInWebKit",
];

const ALLOWED: ReadonlySet<string> = new Set(CONFIG_SETTING_KEYS);

export const isConfigSettingKey = (key: string): key is SettingKey => ALLOWED.has(key);
