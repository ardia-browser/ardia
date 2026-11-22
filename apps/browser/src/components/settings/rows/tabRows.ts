import { type SettingsEnv, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { newTabOpensOf } from "../../../state/settings/settings";
import { t } from "../../../lib/uiLanguage";


const inSidebar = (_: unknown, env: SettingsEnv) => !env.top;

export const tabRows = {
  tabs: [
    {
      section: t(`Layout`),
      rows: {
        layout: {
          title: t(`Tab layout`),
          description: t(`In the sidebar or across the top.`),
          keywords: [t(`vertical tabs`), t(`horizontal tabs`), t(`top tabs`), "sidebar"],
        },
        sidebarSide: {
          title: t(`Sidebar position`),
          description: t(`Left, like Dia, or right, like Arc.`),
          keywords: ["right", "left", "side", "position", "flip", "mirror", t(`sidebar on the right`), t(`right sidebar`), "arc"],
          shown: inSidebar,
        },
        autoHideTabs: {
          title: t(`Auto-hide tabs`),
          explained: true,
          description: `Tabs slide away until you point at the window's edge. ${keyText("⌘S")} toggles them in one window.`,
          keywords: [t(`hide tabs`), t(`hide sidebar`), t(`show sidebar`), t(`toggle sidebar`), t(`hide tab bar`), t(`tab strip`), t(`top tabs`), t(`focus mode`), t(`full screen`), "zen"],
        },
        hideToolbarWhileScrolling: {
          title: t(`Hide toolbar while scrolling`),
          description: t(`Scrolling down shrinks the toolbar to a thin strip.`),
          keywords: [t(`hide toolbar`), t(`auto hide toolbar`), t(`toolbar hides`), t(`address bar hides`), "collapse", "compact", "scroll", "shrink", "shrinking", t(`address bar shrinks`), t(`toolbar shrinks`), t(`page shifts`), t(`page jumps`)],
        },
        buttons: {
          title: t(`Buttons`),
          explained: true,
          description: t(`Hide Tabs and Clear in the sidebar.`),
          keywords: [t(`toggle sidebar`), t(`sidebar button`), t(`hide tabs button`), t(`show the hide tabs button`), t(`clear unpinned tabs`), t(`close all tabs`), t(`clear today`), "divider", "arc", t(`show clear button`), t(`clear button`)],
        },
      },
    },
    {
      section: t(`Tabs and Top Apps`),
      rows: {
        badges: {
          title: t(`Badges`),
          explained: true,
          description: t(`Unread counts on tabs, and playing or muted on Top Apps.`),
          keywords: ["unread", "badge", "badges", "bubble", "bubbles", "count", "notification", "notifications", "notis", "dot", "red", "gmail", "inbox", "messages", "arc", t(`show unread counts on tabs`), t(`pinned tiles`), "favorites", "indicators", t(`unread count`), "speaker", "audio", "muted", "playing", "clean", "dia", t(`show tab status on top apps`), t(`unread counts`), t(`tab status`)],
        },
        sleepingTabs: {
          title: t(`Sleeping and unloaded tabs`),
          description: t(`How tabs whose page isn't loaded look.`),
          keywords: ["unloaded", "asleep", "sleeping", "discarded", "dim", "grey", "gray", "inactive", "pinned", "closed", t(`fade icons of unloaded tabs`), "strikethrough", "strike", t(`line through`), t(`crossed out`), t(`memory saver`), "title", t(`strike through sleeping tabs`), "fade", t(`strike through`)],
        },
        keepTopAppsRunning: {
          title: t(`Keep Top Apps running when closed`),
          explained: true,
          description: `${keyText("⌘W")} switches away but keeps the page loaded, so notifications still arrive.`,
          keywords: [t(`top apps`), t(`pinned tiles`), "favorites", "essentials", t(`cmd w`), "close", "unload", t(`keep loaded`), t(`keep running`), "background", "arc"],
        },
        closedTopAppTiles: {
          title: t(`Draw tiles for closed Top Apps`),
          explained: true,
          description: t(`Off, Top Apps that aren't open show a faded icon.`),
          keywords: [t(`pinned tiles`), "favorites", t(`top apps`), "tile", "tiles", "background", "closed", "open", "unloaded", "faded", "contrast", "prominent", "quiet", "subtle", "dia"],
        },
        balancedTopApps: {
          title: t(`Grow Top Apps as the sidebar widens`),
          explained: true,
          description: t(`Up to four per row, sized to the sidebar, like Arc.`),
          keywords: [t(`pinned tiles`), "favorites", "grid", "columns", "rows", "arc"],
          shown: inSidebar,
        },
        topAppFolders: {
          title: t(`Make folders in Top Apps`),
          explained: true,
          description: t(`Hold one Top App over another to make a folder.`),
          keywords: ["folder", "folders", t(`top apps`), t(`pinned tiles`), "favorites", "group", t(`tile folder`), "stack"],
        },
        tabReorderHaptics: {
          title: t(`Haptic feedback when reordering tabs`),
          description: t(`The trackpad ticks as a dragged tab moves to a new place or over another window.`),
          keywords: ["haptic", "haptics", "trackpad", t(`force touch`), "tick", "vibration", "feedback", "drag", "reorder", t(`move tabs`)],
          shown: () => PLATFORM_FEATURES.haptics,
        },
        showTabHoverMenu: {
          title: t(`Show tab hover menu`),
          description: t(`Rest on a tab to see its address and quick actions.`),
          keywords: ["hover", t(`hover card`), "popup", "pop-up", "tooltip", t(`tab actions`), "reset", "distracting", "dia"],
        },
        showFullUrlInTabHoverMenu: {
          title: t(`Show full address in tab hover menu`),
          description: t(`Off, it shows only the domain.`),
          keywords: ["hover", t(`hover card`), "popup", "url", "address", "link", "domain", t(`full url`), "path"],
        },
        autoPictureInPicture: {
          title: t(`Automatic Picture in Picture`),
          description: t(`Videos and calls pop out when you switch tabs or leave the window.`),
          keywords: ["pip", "video", "floating", t(`mini player`)],
        },
        playingNowAcrossProfiles: {
          title: t(`Keep Playing now across profiles`),
          explained: true,
          description: t(`Media playing in one profile stays in the sidebar of every profile, like Arc's spaces.`),
          keywords: [t(`playing now`), t(`now playing`), t(`media card`), t(`media controls`), t(`sidebar player`), "music", "spotify", "youtube", "spaces", "swipe", "follow", "persist", t(`every space`), t(`all spaces`), "arc"],
        },
        videoUpscaling: {
          title: t(`Video upscaling`),
          description: t(`Sharpens low-resolution video in the tab you're watching, on Apple silicon.`),
          keywords: [t(`super resolution`), "sharpen", t(`video quality`)],
          shown: () => PLATFORM_FEATURES.videoUpscaling,
        },
      },
    },
    {
      section: t(`New tabs`),
      rows: {
        newTabOpens: {
          title: t(`New tab opens`),
          description: `Command Bar opens over the page when you press ${keyText("⌘T")}, like Arc.`,
          keywords: [t(`new tab page`), t(`command bar`), t(`cmd t`)],
        },
        newTabUrl: {
          title: t(`Custom address`),
          explained: true,
          description: t(`A page to open instead of the New Tab page. Leave empty for the default.`),
          keywords: [t(`custom new tab`), t(`new tab url`), t(`home page`), "homepage", t(`start page`), t(`custom url`), t(`cmd t`), t(`new tab page address`)],
          shown: (s) => newTabOpensOf(s) === "page",
          needs: t(`Set New tab opens to New Tab page`),
        },
        newTabPosition: {
          title: t(`Add new tabs`),
          description: `Where ${keyText("⌘T")} puts the new tab.`,
          keywords: [t(`new tab position`), t(`next to current tab`), t(`after current tab`), "beside", t(`right of`), "below", "adjacent", "end", "left", "top", "bottom", "order", t(`cmd t`), t(`new tab button`), "plus", "+", "sticky", "docked", "position"],
        },
        appLinksFirst: {
          title: t(`Put links from other apps first`),
          explained: true,
          description: t(`They go to the top, just below your pinned tabs.`),
          keywords: [t(`external links`), t(`other apps`), t(`default browser`), "top", "first", "left", "position"],
        },
        shareTabsAcrossWindows: {
          title: t(`Share tabs across windows`),
          explained: true,
          description: t(`Every window shows the same tabs, like Arc.`),
          keywords: ["arc", t(`multiple windows`), t(`same tabs`), t(`sync windows`), t(`shared sidebar`), "unpinned"],
        },
      },
    },
    {
      section: t(`Links`),
      rows: {
        openLinksInLittleArdia: {
          title: t(`Open links from other apps in Little Ardia`),
          keywords: [t(`little ardia`), t(`little arc`), "arc", t(`little window`), t(`small window`), t(`mini window`), t(`external links`), t(`links from other apps`), t(`open links`), "discord", "slack", "mail", "messages"],
        },
        littleArdiaOpensNewTabLinks: {
          title: t(`Keep new-tab links inside a Little Ardia window`),
          explained: true,
          description: `A link in Little Ardia that would open a new tab loads right there. ${keyText("⌘")}-click still opens it behind.`,
          keywords: [t(`target blank`), t(`new tab`), "links", "inside"],
          shown: () => PLATFORM_FEATURES.keepsNewTabLinksInLittleArdia,
        },
        littleArdiaShortcutFromAnyApp: {
          title: t(`Shortcut opens Little Ardia from other apps`),
          explained: true,
          description: t(`New Little Ardia Window's shortcut opens Little Ardia while another app is in front. Off, that app keeps the shortcut.`),
          shown: () => PLATFORM_FEATURES.littleArdiaShortcutFromAnyApp,
          keywords: [t(`global shortcut`), t(`global hotkey`), "hotkey", "shortcut", t(`any app`), t(`other apps`), t(`system wide`), t(`option command n`), t(`new little ardia window`)],
        },
        peekLinksToOtherSites: {
          title: t(`Links to other sites open in`),
          explained: true,
          description: t(`From Top Apps and pinned tabs.`),
          keywords: ["peek", "preview", t(`external links`), t(`other sites`), "pinned", t(`pinned tabs`), t(`top apps`), "favorites", "glance", "arc", "zen", "gmail", t(`target blank`), t(`open a peek window when clicking on links to other sites`)],
        },
        newTabLinksOpenIn: {
          title: t(`Links that would open a new tab`),
          explained: true,
          description: t(`When you click a link that would open a new tab.`),
          keywords: ["peek", t(`new tab`), t(`target blank`), "links", "preview", t(`open links`), t(`open new-tab links in`)],
        },
        popupsOpenAsTabs: {
          title: t(`Open pop-ups as tabs`),
          explained: true,
          description: t(`Pop-up windows from pages open as tabs instead.`),
          keywords: ["popup", "pop-up", t(`pop up`), "window.open", t(`new window`), "outlook", t(`sign in`), "oauth", t(`as tab`), "links", t(`open pop-up windows as tabs`)],
        },
        peekButtons: {
          title: t(`Show Peek buttons`),
          explained: true,
          description: t(`Close, Open as Tab and Split View sit in the Peek's title bar, or float beside it on the left or right.`),
          keywords: ["peek", "buttons", "close", "expand", t(`split view`), "left", "right", "side", "position", "arc", "zen", "glance"],
        },
      },
    },
    {
      section: t(`Clean up`),
      rows: {
        cleanUp: {
          title: t(`Close unused tabs after`),
          description: t(`Closes tabs you haven't used in this long.`),
          keywords: ["archive", t(`auto close`), t(`inactive tabs`), "duplicates", "custom", "minutes", t(`clean up tabs i haven't used in`)],
        },
        suggestCleanUp: {
          title: t(`Suggest a clean-up`),
          description: t(`Shows a card once 10 or more tabs go unused.`),
          keywords: ["upsell", "tidy", "suggestion", t(`don't show again`), "card", t(`inactive tabs`), t(`suggest cleaning up when tabs pile up`)],
          shown: (s) => s.cleanUpInactiveTabsAfterMinutes === null,
          needs: t(`Set Close unused tabs after to Never`),
        },
        tidyTabs: {
          title: t(`Tidy Tabs`),
          explained: true,
          description: t(`Groups tabs by site once you have more than six.`),
          keywords: ["tidy", "broom", t(`organize tabs`), t(`group by site`), t(`clean up`), t(`arc max`)],
          shown: inSidebar,
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "tabs">;
