import type { SettingKey } from "./settings";

export const CONFIG_SETTING_KEYS: readonly SettingKey[] = [
  "warnBeforeQuitting", "warnBeforeClosingWindow", "restoreSession", "searchEngine", "searchSuggestions", "commandBarHistory", "showSelectionSearch", "blockNotificationRequests",
  "commandBarPreference", "tabLayout", "autoHideTabs", "revealTabsOnHover", "sidebarSide", "hideToolbarWhileScrolling", "newTabPosition", "newTabButtonPosition", "appLinksFirst", "newTabOpens", "reuseEmptyNewTab",
  "warnBeforeClosingLastTab", "keepTopAppsRunning", "undoReopensClosedTab", "warnBeforeMovingTabsToProfile", "shareTabsAcrossWindows", "tabReorderHaptics",
  "extendWebsiteColor", "cmdClickCreatesTabGroup", "optShiftClickOpensInGroup", "dragToGroupInTopStrip", "peekModifier", "peekLinksToOtherSites", "newTabLinksOpenIn", "popupsOpenAsTabs", "peekButtons",
  "splitLinkModifier", "autoGroupMeetingTabs", "cleanUpInactiveTabsAfterMinutes", "suggestCleanUp", "mutedSites", "showUnreadCounts", "showTopAppBadges", "showTabHoverMenu", "closedTopAppTiles", "unreadHiddenSites", "neverTranslateSites", "showTranslateButton",
  "autoPictureInPicture", "blockAutoplayEverywhere", "commandScrollZoom", "videoUpscaling", "sidebarMediaControls", "sidebarWidth", "showSidebarButton",
  "showClearButton", "tidyTabs", "balancedTopApps", "showAdvancedSettings", "selectedTabGlow", "interfaceScale", "sidebarTextSize", "sidebarTextContrast", "selectedTopApp", "elementOutlines", "interfaceStyle", "glassTintWithTheme",
  "glassTintAmount", "pageScrollBars", "fadeUnloadedTabs", "strikeSleepingTabs", "sleepingTabsInSwitcher", "grayscaleUnloadedFavicons", "fadeUnloadedTabTitles", "warnBeforeClosingTabGroup", "batterySaverWhen", "memorySaver",
  "memorySaverMode", "loadProfilesWhenOpened", "unloadProfilesAfter", "keepActiveSites", "extensionSidePanelWidth", "showFullUrl", "showBookmarks", "bookmarksBar", "bookmarksBarSize",
  "hideBookmarksBarImport", "appearance", "addressBar", "compactToolbar", "addressBarButtons", "borderlessMode", "tabCornerRadius", "minimalismMode", "pageFrame", "pageFrameZeroInFullScreen", "pageFrameZeroWhenTabsHidden", "commandBarPlacement", "spacesFollowAppearance", "adaptTextToColor",
  "showProfileDots", "profileSwitcherIcons", "compactCliPill", "shortcuts", "openLinksInLittleArdia", "littleArdiaOpensNewTabLinks", "littleWindowGestures", "littleArdiaSize",
  "omniboxProviders", "launchActions", "commandBarStart", "readerTextSize", "readerFont",
];

export const CONFIG_EXCLUDED_KEYS: readonly SettingKey[] = [
  "customSearchUrl", "newTabUrl", "customSearchEngines", "extensionSearchEngines", "allowJavaScriptFromAppleEvents", "cliControl", "defaultProfileId",
  "pageEngine", "websiteEngines", "protectedVideoInWebKit", "fairPlayInChromium",
];

const ALLOWED: ReadonlySet<string> = new Set(CONFIG_SETTING_KEYS);

export const isConfigSettingKey = (key: string): key is SettingKey => ALLOWED.has(key);
