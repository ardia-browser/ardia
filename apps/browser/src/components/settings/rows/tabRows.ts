import { t } from "../../../lib/i18n";
import { type SettingsEnv, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { newTabOpensOf } from "../../../state/settings/settings";

const inSidebar = (_: unknown, env: SettingsEnv) => !env.top;

export const tabRows = {
  tabs: [
    {
      section: "Layout",
      rows: {
        layout: {
          title: t("Tab layout"),
          description: t("In the sidebar or across the top."),
          keywords: ["vertical tabs", "horizontal tabs", "top tabs", "sidebar"],
        },
        sidebarSide: {
          title: t("Sidebar position"),
          description: t("Left, like Dia, or right, like Arc."),
          keywords: ["right", "left", "side", "position", "flip", "mirror", "sidebar on the right", "right sidebar", "arc"],
          shown: inSidebar,
        },
        autoHideTabs: {
          title: t("Auto-hide tabs"),
          explained: true,
          description: `Tabs slide away until you point at the edge. ${keyText("⌘S")} toggles.`,
          keywords: ["hide tabs", "hide sidebar", "show sidebar", "toggle sidebar", "hide tab bar", "tab strip", "top tabs", "focus mode", "full screen", "zen", "window edge", "slide", "one window"],
        },
        hideToolbarWhileScrolling: {
          title: t("Hide toolbar while scrolling"),
          description: t("Scrolling down shrinks the toolbar to a thin strip."),
          keywords: ["hide toolbar", "auto hide toolbar", "toolbar hides", "address bar hides", "collapse", "compact", "scroll", "shrink", "shrinking", "address bar shrinks", "toolbar shrinks", "page shifts", "page jumps"],
        },
        buttons: {
          title: t("Buttons"),
          explained: true,
          description: t("Hide Tabs and Clear in the sidebar."),
          keywords: ["toggle sidebar", "sidebar button", "hide tabs button", "show the hide tabs button", "clear unpinned tabs", "close all tabs", "clear today", "divider", "arc", "show clear button", "clear button"],
        },
      },
    },
    {
      section: "Tabs and Top Apps",
      rows: {
        badges: {
          title: t("Badges"),
          explained: true,
          description: t("Unread counts on tabs, and playing or muted on Top Apps."),
          keywords: ["unread", "badge", "badges", "bubble", "bubbles", "count", "notification", "notifications", "notis", "dot", "red", "gmail", "inbox", "messages", "arc", "show unread counts on tabs", "pinned tiles", "favorites", "indicators", "unread count", "speaker", "audio", "muted", "playing", "clean", "dia", "show tab status on top apps", "unread counts", "tab status"],
        },
        sleepingTabs: {
          title: t("Sleeping and unloaded tabs"),
          description: t("How tabs whose page isn't loaded look."),
          keywords: ["unloaded", "asleep", "sleeping", "discarded", "dim", "grey", "gray", "inactive", "pinned", "closed", "fade icons of unloaded tabs", "strikethrough", "strike", "line through", "crossed out", "memory saver", "title", "strike through sleeping tabs", "fade", "strike through"],
        },
        keepTopAppsRunning: {
          title: t("Keep Top Apps running when closed"),
          explained: true,
          description: `${keyText("⌘W")} switches away but keeps the page loaded for notifications.`,
          keywords: ["top apps", "pinned tiles", "favorites", "essentials", "cmd w", "close", "unload", "keep loaded", "keep running", "background", "arc", "notifications still arrive"],
        },
        closedTopAppTiles: {
          title: t("Draw tiles for closed Top Apps"),
          explained: true,
          description: t("Off, Top Apps that aren't open show a faded icon."),
          keywords: ["pinned tiles", "favorites", "top apps", "tile", "tiles", "background", "closed", "open", "unloaded", "faded", "contrast", "prominent", "quiet", "subtle", "dia"],
        },
        balancedTopApps: {
          title: t("Grow Top Apps as the sidebar widens"),
          explained: true,
          description: t("Up to four per row, sized to the sidebar, like Arc."),
          keywords: ["pinned tiles", "favorites", "grid", "columns", "rows", "arc"],
          shown: inSidebar,
        },
        topAppFolders: {
          title: t("Make folders in Top Apps"),
          explained: true,
          description: t("Hold one Top App over another to make a folder."),
          keywords: ["folder", "folders", "top apps", "pinned tiles", "favorites", "group", "tile folder", "stack"],
        },
        tabReorderHaptics: {
          title: t("Haptic feedback when reordering tabs"),
          description: "The trackpad ticks as a dragged tab moves to a new place or over another window.",
          keywords: ["haptic", "haptics", "trackpad", "force touch", "tick", "vibration", "feedback", "drag", "reorder", "move tabs"],
          shown: () => PLATFORM_FEATURES.haptics,
        },
        swipeBetweenTabs: {
          title: t("Swipe between tabs"),
          description: t("Swipe with two fingers on the address bar to change tabs."),
          keywords: ["swipe", "gesture", "trackpad", "two fingers", "next tab", "previous tab", "toolbar", "address bar", "scroll", "left", "right", "tab above", "tab below"],
          shown: () => PLATFORM_FEATURES.trackpadGestures,
        },
        showTabHoverMenu: {
          title: t("Show tab hover menu"),
          description: t("Rest on a tab to see its address and quick actions."),
          keywords: ["hover", "hover card", "popup", "pop-up", "tooltip", "tab actions", "reset", "distracting", "dia"],
        },
        showFullUrlInTabHoverMenu: {
          title: t("Show full address in tab hover menu"),
          description: t("Off, it shows only the domain."),
          keywords: ["hover", "hover card", "popup", "url", "address", "link", "domain", "full url", "path"],
        },
        autoPictureInPicture: {
          title: t("Automatic Picture in Picture"),
          description: t("Videos and calls pop out when you switch tabs or leave the window."),
          keywords: ["pip", "video", "floating", "mini player"],
        },
        playingNowAcrossProfiles: {
          title: t("Keep Playing now across profiles"),
          explained: true,
          description: t("Media playing in one profile shows in every profile's sidebar."),
          keywords: ["playing now", "now playing", "media card", "media controls", "sidebar player", "music", "spotify", "youtube", "spaces", "swipe", "follow", "persist", "every space", "all spaces", "arc", "arc's spaces", "every profile"],
        },
        videoUpscaling: {
          title: t("Video upscaling"),
          description: t("Sharpens low-resolution video in the tab you're watching, on Apple silicon."),
          keywords: ["super resolution", "sharpen", "video quality"],
          shown: () => PLATFORM_FEATURES.videoUpscaling,
        },
      },
    },
    {
      section: "New tabs",
      rows: {
        newTabOpens: {
          title: t("New tab opens"),
          description: `Command Bar opens over the page when you press ${keyText("⌘T")}, like Arc.`,
          keywords: ["new tab page", "command bar", "cmd t"],
        },
        newTabUrl: {
          title: t("Custom address"),
          explained: true,
          description: t("A page to open instead of the New Tab page. Leave empty for the default."),
          keywords: ["custom new tab", "new tab url", "home page", "homepage", "start page", "custom url", "cmd t", "new tab page address"],
          shown: (s) => newTabOpensOf(s) === "page",
          needs: "Set New tab opens to New Tab page",
        },
        newTabPosition: {
          title: t("Add new tabs"),
          description: `Where ${keyText("⌘T")} puts the new tab.`,
          keywords: ["new tab position", "next to current tab", "after current tab", "beside", "right of", "below", "adjacent", "end", "left", "top", "bottom", "order", "cmd t", "new tab button", "plus", "+", "sticky", "docked", "position"],
        },
        appLinksFirst: {
          title: t("Put links from other apps first"),
          explained: true,
          description: t("They go to the top, just below your pinned tabs."),
          keywords: ["external links", "other apps", "default browser", "top", "first", "left", "position"],
        },
        shareTabsAcrossWindows: {
          title: t("Share tabs across windows"),
          explained: true,
          description: t("Every window shows the same tabs, like Arc."),
          keywords: ["arc", "multiple windows", "same tabs", "sync windows", "shared sidebar", "unpinned"],
        },
      },
    },
    {
      section: "Links",
      rows: {
        openLinksInLittleArdia: {
          title: t("Open links from other apps in Little Ardia"),
          keywords: ["little ardia", "little arc", "arc", "little window", "small window", "mini window", "external links", "links from other apps", "open links", "discord", "slack", "mail", "messages"],
        },
        littleArdiaOpensNewTabLinks: {
          title: t("Keep new-tab links inside a Little Ardia window"),
          explained: true,
          description: `New-tab links load in place. ${keyText("⌘")}-click still opens behind.`,
          keywords: ["target blank", "new tab", "links", "inside", "little ardia", "load right there", "behind", "command click"],
          shown: () => PLATFORM_FEATURES.keepsNewTabLinksInLittleArdia,
        },
        littleArdiaShortcutFromAnyApp: {
          title: t("Shortcut opens Little Ardia from other apps"),
          explained: true,
          description: t("Its shortcut works while another app is in front."),
          shown: () => PLATFORM_FEATURES.littleArdiaShortcutFromAnyApp,
          keywords: ["global shortcut", "global hotkey", "hotkey", "shortcut", "any app", "other apps", "system wide", "option command n", "new little ardia window", "in front", "keeps the shortcut"],
        },
        peekLinksToOtherSites: {
          title: t("Links to other sites open in"),
          explained: true,
          description: t("From Top Apps and pinned tabs."),
          keywords: ["peek", "preview", "external links", "other sites", "pinned", "pinned tabs", "top apps", "favorites", "glance", "arc", "zen", "gmail", "target blank", "open a peek window when clicking on links to other sites"],
        },
        newTabLinksOpenIn: {
          title: t("Links that would open a new tab"),
          explained: true,
          description: t("When you click a link that would open a new tab."),
          keywords: ["peek", "new tab", "target blank", "links", "preview", "open links", "open new-tab links in"],
        },
        popupsOpenAsTabs: {
          title: t("Open pop-ups as tabs"),
          explained: true,
          description: t("Pop-up windows from pages open as tabs instead."),
          keywords: ["popup", "pop-up", "pop up", "window.open", "new window", "outlook", "sign in", "oauth", "as tab", "links", "open pop-up windows as tabs"],
        },
        peekButtons: {
          title: t("Show Peek buttons"),
          explained: true,
          description: "Close, Open as Tab and Split View, in the title bar or beside it.",
          keywords: ["peek", "buttons", "close", "expand", "split view", "left", "right", "side", "position", "arc", "zen", "glance", "open as tab", "title bar", "float", "beside"],
        },
      },
    },
    {
      section: "Clean up",
      rows: {
        cleanUp: {
          title: t("Close unused tabs after"),
          description: t("Closes tabs you haven't used in this long."),
          keywords: ["archive", "auto close", "inactive tabs", "duplicates", "custom", "minutes", "clean up tabs i haven't used in"],
        },
        suggestCleanUp: {
          title: t("Suggest a clean-up"),
          description: t("Shows a card once 10 or more tabs go unused."),
          keywords: ["upsell", "tidy", "suggestion", "don't show again", "card", "inactive tabs", "suggest cleaning up when tabs pile up"],
          shown: (s) => s.cleanUpInactiveTabsAfterMinutes === null,
          needs: "Set Close unused tabs after to Never",
        },
        tidyTabs: {
          title: t("Tidy Tabs"),
          explained: true,
          description: t("Groups tabs by site once you have more than six."),
          keywords: ["tidy", "broom", "organize tabs", "group by site", "clean up", "arc max"],
          shown: inSidebar,
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "tabs">;
