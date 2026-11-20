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
          title: "Tab layout",
          description: "In the sidebar or across the top.",
          keywords: ["vertical tabs", "horizontal tabs", "top tabs", "sidebar"],
        },
        sidebarSide: {
          title: "Sidebar position",
          description: "Left, like Dia, or right, like Arc.",
          keywords: ["right", "left", "side", "position", "flip", "mirror", "sidebar on the right", "right sidebar", "arc"],
          shown: inSidebar,
        },
        autoHideTabs: {
          title: "Auto-hide tabs",
          explained: true,
          description: `Tabs slide away until you point at the window's edge. ${keyText("⌘S")} toggles them in one window.`,
          keywords: ["hide tabs", "hide sidebar", "show sidebar", "toggle sidebar", "hide tab bar", "tab strip", "top tabs", "focus mode", "full screen", "zen"],
        },
        hideToolbarWhileScrolling: {
          title: "Hide toolbar while scrolling",
          description: "Scrolling down shrinks the toolbar to a thin strip.",
          keywords: ["auto hide toolbar", "address bar hides", "collapse", "compact", "scroll", "shrink", "shrinking", "address bar shrinks", "toolbar shrinks", "page shifts", "page jumps"],
        },
        buttons: {
          title: "Buttons",
          explained: true,
          description: "Hide Tabs and Clear in the sidebar.",
          keywords: ["toggle sidebar", "sidebar button", "hide tabs button", "show the hide tabs button", "clear unpinned tabs", "close all tabs", "clear today", "divider", "arc", "show clear button", "clear button"],
        },
      },
    },
    {
      section: "Tabs and Top Apps",
      rows: {
        badges: {
          title: "Badges",
          explained: true,
          description: "Unread counts on tabs, and playing or muted on Top Apps.",
          keywords: ["unread", "badge", "badges", "bubble", "bubbles", "count", "notification", "notifications", "notis", "dot", "red", "gmail", "inbox", "messages", "arc", "show unread counts on tabs", "pinned tiles", "favorites", "indicators", "unread count", "speaker", "audio", "muted", "playing", "clean", "dia", "show tab status on top apps", "unread counts", "tab status"],
        },
        sleepingTabs: {
          title: "Sleeping and unloaded tabs",
          description: "How tabs whose page isn't loaded look.",
          keywords: ["unloaded", "asleep", "sleeping", "discarded", "dim", "grey", "gray", "inactive", "pinned", "closed", "fade icons of unloaded tabs", "strikethrough", "strike", "line through", "crossed out", "memory saver", "title", "strike through sleeping tabs", "fade", "strike through"],
        },
        keepTopAppsRunning: {
          title: "Keep Top Apps running when closed",
          explained: true,
          description: `${keyText("⌘W")} switches away but keeps the page loaded, so notifications still arrive.`,
          keywords: ["top apps", "pinned tiles", "favorites", "essentials", "cmd w", "close", "unload", "keep loaded", "keep running", "background", "arc"],
        },
        closedTopAppTiles: {
          title: "Draw tiles for closed Top Apps",
          explained: true,
          description: "Off, Top Apps that aren't open show a faded icon.",
          keywords: ["pinned tiles", "favorites", "top apps", "tile", "tiles", "background", "closed", "open", "unloaded", "faded", "contrast", "prominent", "quiet", "subtle", "dia"],
        },
        balancedTopApps: {
          title: "Grow Top Apps as the sidebar widens",
          explained: true,
          description: "Up to four per row, sized to the sidebar, like Arc.",
          keywords: ["pinned tiles", "favorites", "grid", "columns", "rows", "arc"],
          shown: inSidebar,
        },
        topAppFolders: {
          title: "Make folders in Top Apps",
          explained: true,
          description: "Hold one Top App over another to make a folder.",
          keywords: ["folder", "folders", "top apps", "pinned tiles", "favorites", "group", "tile folder", "stack"],
        },
        tabReorderHaptics: {
          title: "Haptic feedback when reordering tabs",
          description: "The trackpad ticks as a dragged tab moves to a new place or over another window.",
          keywords: ["haptic", "haptics", "trackpad", "force touch", "tick", "vibration", "feedback", "drag", "reorder", "move tabs"],
          shown: () => PLATFORM_FEATURES.haptics,
        },
        showTabHoverMenu: {
          title: "Show tab hover menu",
          description: "Rest on a tab to see its address and quick actions.",
          keywords: ["hover", "hover card", "popup", "pop-up", "tooltip", "tab actions", "reset", "distracting", "dia"],
        },
        showFullUrlInTabHoverMenu: {
          title: "Show full address in tab hover menu",
          description: "Off, it shows only the domain.",
          keywords: ["hover", "hover card", "popup", "url", "address", "link", "domain", "full url", "path"],
        },
        autoPictureInPicture: {
          title: "Automatic Picture in Picture",
          description: "Videos and calls pop out when you switch tabs or leave the window.",
          keywords: ["pip", "video", "floating", "mini player"],
        },
        playingNowAcrossProfiles: {
          title: "Keep Playing now across profiles",
          explained: true,
          description: "Media playing in one profile stays in the sidebar of every profile, like Arc's spaces.",
          keywords: ["playing now", "now playing", "media card", "media controls", "sidebar player", "music", "spotify", "youtube", "spaces", "swipe", "follow", "persist", "every space", "all spaces", "arc"],
        },
        videoUpscaling: {
          title: "Video upscaling",
          description: "Sharpens low-resolution video in the tab you're watching, on Apple silicon.",
          keywords: ["super resolution", "sharpen", "video quality"],
          shown: () => PLATFORM_FEATURES.videoUpscaling,
        },
      },
    },
    {
      section: "New tabs",
      rows: {
        newTabOpens: {
          title: "New tab opens",
          description: `Command Bar opens over the page when you press ${keyText("⌘T")}, like Arc.`,
          keywords: ["new tab page", "command bar", "cmd t"],
        },
        newTabUrl: {
          title: "Custom address",
          explained: true,
          description: "A page to open instead of the New Tab page. Leave empty for the default.",
          keywords: ["custom new tab", "new tab url", "home page", "homepage", "start page", "custom url", "cmd t", "new tab page address"],
          shown: (s) => newTabOpensOf(s) === "page",
          needs: "Set New tab opens to New Tab page",
        },
        newTabPosition: {
          title: "Add new tabs",
          description: `Where ${keyText("⌘T")} puts the new tab.`,
          keywords: ["new tab position", "next to current tab", "after current tab", "beside", "right of", "below", "adjacent", "end", "left", "top", "bottom", "order", "cmd t", "new tab button", "plus", "+", "sticky", "docked", "position"],
        },
        appLinksFirst: {
          title: "Put links from other apps first",
          explained: true,
          description: "They go to the top, just below your pinned tabs.",
          keywords: ["external links", "other apps", "default browser", "top", "first", "left", "position"],
        },
        shareTabsAcrossWindows: {
          title: "Share tabs across windows",
          explained: true,
          description: "Every window shows the same tabs, like Arc.",
          keywords: ["arc", "multiple windows", "same tabs", "sync windows", "shared sidebar", "unpinned"],
        },
      },
    },
    {
      section: "Links",
      rows: {
        openLinksInLittleArdia: {
          title: "Open links from other apps in Little Ardia",
          keywords: ["little ardia", "little arc", "arc", "little window", "small window", "mini window", "external links", "links from other apps", "open links", "discord", "slack", "mail", "messages"],
        },
        littleArdiaOpensNewTabLinks: {
          title: "Keep new-tab links inside a Little Ardia window",
          explained: true,
          description: `A link in Little Ardia that would open a new tab loads right there. ${keyText("⌘")}-click still opens it behind.`,
          keywords: ["target blank", "new tab", "links", "inside"],
          shown: () => PLATFORM_FEATURES.keepsNewTabLinksInLittleArdia,
        },
        littleArdiaShortcutFromAnyApp: {
          title: "Shortcut opens Little Ardia from other apps",
          explained: true,
          description: "New Little Ardia Window's shortcut opens Little Ardia while another app is in front. Off, that app keeps the shortcut.",
          shown: () => PLATFORM_FEATURES.littleArdiaShortcutFromAnyApp,
          keywords: ["global shortcut", "global hotkey", "hotkey", "shortcut", "any app", "other apps", "system wide", "option command n", "new little ardia window"],
        },
        peekLinksToOtherSites: {
          title: "Links to other sites open in",
          explained: true,
          description: "From Top Apps and pinned tabs.",
          keywords: ["peek", "preview", "external links", "other sites", "pinned", "pinned tabs", "top apps", "favorites", "glance", "arc", "zen", "gmail", "target blank", "open a peek window when clicking on links to other sites"],
        },
        newTabLinksOpenIn: {
          title: "Links that would open a new tab",
          explained: true,
          description: "When you click a link that would open a new tab.",
          keywords: ["peek", "new tab", "target blank", "links", "preview", "open links", "open new-tab links in"],
        },
        popupsOpenAsTabs: {
          title: "Open pop-ups as tabs",
          explained: true,
          description: "Pop-up windows from pages open as tabs instead.",
          keywords: ["popup", "pop-up", "pop up", "window.open", "new window", "outlook", "sign in", "oauth", "as tab", "links", "open pop-up windows as tabs"],
        },
        peekButtons: {
          title: "Show Peek buttons",
          explained: true,
          description: "Close, Open as Tab and Split View sit in the Peek's title bar, or float beside it on the left or right.",
          keywords: ["peek", "buttons", "close", "expand", "split view", "left", "right", "side", "position", "arc", "zen", "glance"],
        },
      },
    },
    {
      section: "Clean up",
      rows: {
        cleanUp: {
          title: "Close unused tabs after",
          description: "Closes tabs you haven't used in this long.",
          keywords: ["archive", "auto close", "inactive tabs", "duplicates", "custom", "minutes", "clean up tabs i haven't used in"],
        },
        suggestCleanUp: {
          title: "Suggest a clean-up",
          description: "Shows a card once 10 or more tabs go unused.",
          keywords: ["upsell", "tidy", "suggestion", "don't show again", "card", "inactive tabs", "suggest cleaning up when tabs pile up"],
          shown: (s) => s.cleanUpInactiveTabsAfterMinutes === null,
          needs: "Set Close unused tabs after to Never",
        },
        tidyTabs: {
          title: "Tidy Tabs",
          explained: true,
          description: "Groups tabs by site once you have more than six.",
          keywords: ["tidy", "broom", "organize tabs", "group by site", "clean up", "arc max"],
          shown: inSidebar,
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "tabs">;
