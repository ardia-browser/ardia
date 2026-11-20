import type { SettingKey } from "./settings";

export const CONFIG_SETTING_KEYS: readonly SettingKey[] = [
  "warnBeforeQuitting", "warnBeforeClosingWindow", "restoreSession", "separateDownloadFolders", "searchEngine", "searchSuggestions", "commandBarHistory", "showSelectionSearch", "blockNotificationRequests",
  "tabLayout", "autoHideTabs", "sidebarSide", "hideToolbarWhileScrolling", "newTabPosition", "newTabButtonPosition", "appLinksFirst", "newTabOpens",
  "warnBeforeClosingLastTab", "keepTopAppsRunning", "undoReopensClosedTab", "warnBeforeMovingTabsToProfile", "shareTabsAcrossWindows",
  "extendWebsiteColor", "cmdClickCreatesTabGroup", "optShiftClickOpensInGroup", "peekModifier", "peekLinksToOtherSites", "newTabLinksOpenIn", "popupsOpenAsTabs", "peekButtons",
  "splitLinkModifier", "autoGroupMeetingTabs", "cleanUpInactiveTabsAfterMinutes", "suggestCleanUp", "mutedSites", "showUnreadCounts", "showTopAppBadges", "showTabHoverMenu", "showFullUrlInTabHoverMenu", "closedTopAppTiles", "topAppFolders", "unreadHiddenSites", "neverTranslateSites", "developerModeSites",
  "autoPictureInPicture", "playingNowAcrossProfiles", "blockAutoplayEverywhere", "videoUpscaling", "sidebarWidth", "showSidebarButton",
  "showClearButton", "tidyTabs", "balancedTopApps", "selectedTabGlow", "interfaceScale", "sidebarTextSize", "sidebarTextContrast", "selectedTopApp", "elementOutlines", "interfaceStyle", "glassTintWithTheme",
  "glassTintAmount", "fadeUnloadedTabs", "strikeSleepingTabs", "warnBeforeClosingTabGroup", "batterySaverWhen", "memorySaver",
  "memorySaverMode", "loadProfilesWhenOpened", "unloadProfilesAfter", "keepActiveSites", "extensionSidePanelWidth", "showFullUrl", "showBookmarks", "bookmarksBar",
  "bookmarksImportDismissed", "appearance", "addressBar", "compactToolbar", "addressBarButtons", "borderlessMode", "tabCornerRadius", "minimalismMode", "pageFrame", "pageFrameZeroInFullScreen", "pageFrameZeroWhenTabsHidden", "commandBarPlacement", "spacesFollowAppearance",
  "showProfileDots", "profileSwitcherIcons", "compactCliPill", "shortcuts", "openLinksInLittleArdia", "littleArdiaOpensNewTabLinks", "littleArdiaSize",
  "omniboxProviders", "launchActions", "commandBarStart", "readerTextSize", "readerFont",
];

export const CONFIG_EXCLUDED_KEYS: readonly SettingKey[] = [
  "customSearchUrl", "newTabUrl", "customSearchEngines", "extensionSearchEngines", "allowJavaScriptFromAppleEvents", "cliControl", "defaultProfileId",
  "engineMode", "pageEngine", "websiteEngines", "protectedVideoInWebKit", "offerWebKitForProtectedVideo", "engineSwitchKeepsPage",
  "engineSwitchAsksAboutUnsavedWork",
];

const ALLOWED: ReadonlySet<string> = new Set(CONFIG_SETTING_KEYS);

export const isConfigSettingKey = (key: string): key is SettingKey => ALLOWED.has(key);
