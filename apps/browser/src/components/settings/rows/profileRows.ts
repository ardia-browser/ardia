import { type SettingsEnv, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { t } from "../../../lib/uiLanguage";


const syncOn = (_: unknown, env: SettingsEnv) => !!env.syncOn;

export const profileRows = {
  profiles: [
    {
      section: t(`Profiles`),
      rows: {
        profiles: {
          title: t(`Profiles`),
          explained: true,
          description: `Pick a profile in the bar to change its settings. Drag to reorder. ${keyText("⌃1")}–${keyText("⌃9")} switch between them.`,
          keywords: [t(`create profile`), t(`new profile`), t(`delete profile`), "reorder", "work", "personal"],
        },
      },
    },
    {
      section: t(`For all profiles`),
      rows: {
        defaultProfile: {
          title: t(`Default profile`),
          description: t(`Used for new windows.`),
          keywords: [t(`new window`)],
        },
        showProfileDots: {
          title: t(`Show the profile switcher in the sidebar`),
          explained: true,
          description: t(`A dot for each profile, or its icon if you gave it one.`),
          keywords: ["dots", "pager", t(`profile switcher`), t(`page dots`), t(`sidebar footer`), "hide", t(`show profile dots`), "spaces", t(`space icons`), t(`profile dots`), "switcher", "emoji", "symbol", "arc", t(`show profile icons instead of dots`), t(`profile icons`), t(`switcher in the sidebar shows`), "nothing"],
        },
        shareTopApps: {
          title: t(`Share Top Apps`),
          keywords: [t(`pinned tabs`), "favorites", "essentials", "spaces", "shared"],
        },
        spacesFollowAppearance: {
          title: t(`Profile colors follow the theme`),
          explained: true,
          description: t(`Every profile follows this, whatever its theme says.`),
          keywords: ["space", t(`profile theme`), t(`arc theme`), t(`follow system`), t(`profile themes follow this appearance`)],
        },
      },
    },
    {
      section: t(`This profile`),
      rows: {
        themeColor: {
          title: t(`Colour`),
          description: t(`Pick a theme colour and edit it: colours, intensity, blur, noise and direction.`),
          keywords: ["theme", t(`theme colour`), t(`theme color`), "color", "gradient", t(`custom theme`), t(`custom colour`), t(`edit theme`), t(`reset theme`), "intensity", t(`pass-through blur`), "noise", "grain", "direction", "tint"],
        },
        syncThisProfile: {
          title: t(`Sync this profile`),
          keywords: [t(`sync profile`), "sync"],
          shown: syncOn,
          needs: t(`Turn on Sync to use this`),
        },
        profileDownloadsFolder: {
          title: t(`Downloads folder`),
          keywords: [t(`download location`), t(`save to`), "folder"],
          shown: (s) => s.separateDownloadFolders,
          needs: t(`Turn on Separate folder for each profile in General`),
        },
        preloadPages: {
          title: t(`Preload pages`),
          explained: true,
          description: t(`Links open faster, but pages you may never visit are fetched too.`),
          keywords: ["preload", "prerender", "preconnect", "prefetch", "speed", "faster", t(`slow connection`), "latency", t(`network predictions`)],
          shown: () => PLATFORM_FEATURES.preloadPages,
        },
        siteSettings: {
          title: t(`Site settings`),
          description: t(`Permissions, autoplay, notifications and zoom.`),
          keywords: ["camera", "microphone", "location", "popups", "cookies", "javascript", t(`clear site data`), t(`website settings`), t(`site permissions`), "autoplay", t(`auto play`), t(`videos playing`), t(`stop videos`), t(`media autoplay`), t(`muted autoplay`), t(`block autoplay on every site`), t(`push notifications`), t(`notification prompts`), t(`notification requests`), t(`stop asking`), t(`notification spam`), t(`block requests to send notifications`), t(`zoom levels`), "permissions", "notifications"],
        },
      },
    },
    {
      section: t(`Search`),
      rows: {
        searchEngine: {
          title: t(`Search engine`),
          description: t(`Used by the command bar and the New Tab page.`),
          keywords: ["google", "duckduckgo", "bing", "kagi", "ecosia", t(`default search engine`)],
        },
        otherEngines: {
          title: t(`Other search engines`),
          description: t(`Type a shortcut and press Tab to search a site directly.`),
          keywords: [t(`custom search`), t(`site search`), "keyword"],
        },
        suggestWhileTyping: {
          title: t(`Suggest while typing`),
          explained: true,
          description: t(`Searches and pages from your history.`),
          keywords: ["autocomplete", t(`show search suggestions`), "history", t(`visited pages`), t(`browsing history`), t(`hide history`), "autofill", t(`inline completion`), t(`recent pages`), t(`command bar`), "omnibox", t(`suggest pages from history`), t(`search suggestions`), t(`history suggestions`)],
        },
        showSelectionSearch: {
          title: t(`Search button on selected text`),
          description: t(`Shows a Search button over text you select.`),
          keywords: ["selection", t(`selected text`), "popover", "popup", "highlight", t(`show search button when selecting text`)],
        },
      },
    },
    {
      section: t(`Passwords and autofill`),
      rows: {
        passwordManager: {
          title: t(`Password manager`),
          description: t(`Ardia's own, a password manager plugin, or none when an extension handles logins.`),
          keywords: [t(`password manager`), t(`passwords app`), "passkeys", t(`verification codes`), t(`2fa`), t(`one time code`), t(`autofill passwords`)],
          shown: () => PLATFORM_FEATURES.systemPasswordManagers && PLATFORM_FEATURES.plugins,
        },
        offerToSavePasswords: {
          title: t(`Save and fill passwords`),
          description: t(`Offers to save logins and fills saved ones.`),
          keywords: [t(`password manager`), "logins", "credentials", "keychain", t(`offer to save and fill passwords`)],
          shown: () => PLATFORM_FEATURES.passwordAutofillSwitch,
        },
        passwords: {
          title: t(`Passwords`),
          description: t(`Saved passwords, import and export.`),
          keywords: ["csv", "logins", t(`import passwords`), "backup", t(`export passwords`), t(`saved passwords`), t(`never saved`), t(`1password`), "bitwarden", t(`password manager`)],
        },
        addresses: {
          title: t(`Save and fill addresses`),
          description: t(`Names, addresses, email addresses and phone numbers.`),
          keywords: ["forms", "contact", "phone", "email", t(`add address`), "addresses"],
        },
        savedAddresses: {
          title: t(`Saved addresses`),
          description: t(`Names, addresses, email addresses and phone numbers.`),
          keywords: [t(`edit address`), t(`add address`), "contact", "phone", "email"],
        },
        cards: {
          title: t(`Save and fill cards`),
          explained: true,
          description: `Showing or filling a card asks for ${PLATFORM_TERMS.deviceUnlock}.`,
          keywords: ["payment", t(`debit card`), "forms", t(`save and fill credit cards`), t(`credit cards`)],
        },
        savedCards: {
          title: t(`Saved cards`),
          keywords: [t(`edit card`), t(`add card`), "payment", t(`credit card`), t(`debit card`)],
        },
      },
    },
    {
      section: t(`Extensions`),
      rows: {
        extensions: {
          title: t(`Installed extensions`),
          description: t(`From the Chrome Web Store. Each profile has its own.`),
          keywords: [t(`add ons`), "plugins", "installed", "extensions", t(`install extension`), "url", t(`add from a link`), t(`developer mode`), t(`load unpacked extension`)],
        },
        webStore: {
          title: t(`Get extensions`),
          description: t(`Add to Ardia installs into this profile.`),
          keywords: [t(`install extension`), t(`chrome web store`)],
        },
      },
    },
    {
      section: t(`Data`),
      rows: {
        exportBookmarks: {
          title: t(`Export bookmarks`),
          description: t(`As an HTML file any browser can import.`),
          keywords: ["backup", "html", "netscape", "bookmarks.html", t(`save bookmarks`), "transfer"],
          shown: () => PLATFORM_FEATURES.exportsBookmarksAndPasswords,
        },
        clearBrowsingData: {
          title: t(`Clear browsing data`),
          keywords: [t(`clear history`), "cookies", "cache", t(`delete data`)],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "profiles">;
