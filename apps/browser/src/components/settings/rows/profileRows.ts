import { t } from "../../../lib/i18n";
import { type SettingsEnv, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";

const syncOn = (_: unknown, env: SettingsEnv) => !!env.syncOn;

export const profileRows = {
  profiles: [
    {
      section: "Profiles",
      rows: {
        profiles: {
          title: t("Profiles"),
          explained: true,
          description: `Pick one to edit it; drag to reorder. ${keyText("⌃1")}–${keyText("⌃9")} switch.`,
          keywords: ["create profile", "new profile", "delete profile", "reorder", "work", "personal", "drag", "switch profiles", "profile settings"],
        },
      },
    },
    {
      section: "This profile",
      rows: {
        themeColor: {
          title: t("Colour"),
          description: "Pick a theme colour and edit it: colours, intensity, blur, noise and direction.",
          keywords: ["theme", "theme colour", "theme color", "color", "gradient", "custom theme", "custom colour", "edit theme", "reset theme", "intensity", "pass-through blur", "noise", "grain", "direction", "tint"],
        },
        syncThisProfile: {
          title: t("Sync this profile"),
          keywords: ["sync profile", "sync"],
          shown: syncOn,
          needs: t("Turn on Sync to use this"),
        },
        profileDownloadsFolder: {
          title: t("Downloads folder"),
          keywords: ["download location", "save to", "folder"],
          shown: (s) => s.separateDownloadFolders,
          needs: "Turn on Separate folder for each profile in General",
        },
        preloadPages: {
          title: t("Preload pages"),
          explained: true,
          description: t("Links open faster, but pages you may never visit are fetched too."),
          keywords: ["preload", "prerender", "preconnect", "prefetch", "speed", "faster", "slow connection", "latency", "network predictions"],
          shown: () => PLATFORM_FEATURES.preloadPages,
        },
        siteSettings: {
          title: t("Site settings"),
          description: t("Permissions, autoplay, notifications and zoom."),
          keywords: ["camera", "microphone", "location", "popups", "cookies", "javascript", "clear site data", "website settings", "site permissions", "autoplay", "auto play", "videos playing", "stop videos", "media autoplay", "muted autoplay", "block autoplay on every site", "push notifications", "notification prompts", "notification requests", "stop asking", "notification spam", "block requests to send notifications", "zoom levels", "permissions", "notifications"],
        },
      },
    },
    {
      section: "Search",
      rows: {
        searchEngine: {
          title: t("Search engine"),
          description: t("Used by the command bar and the New Tab page."),
          keywords: ["google", "duckduckgo", "bing", "kagi", "ecosia", "default search engine"],
        },
        otherEngines: {
          title: t("Other search engines"),
          description: t("Type a shortcut and press Tab to search a site directly."),
          keywords: ["custom search", "site search", "keyword"],
        },
        suggestWhileTyping: {
          title: t("Suggest while typing"),
          explained: true,
          description: t("Searches and pages from your history."),
          keywords: ["autocomplete", "show search suggestions", "history", "visited pages", "browsing history", "hide history", "autofill", "inline completion", "recent pages", "command bar", "omnibox", "suggest pages from history", "search suggestions", "history suggestions"],
        },
        showSelectionSearch: {
          title: t("Search button on selected text"),
          description: t("Shows a Search button over text you select."),
          keywords: ["selection", "selected text", "popover", "popup", "highlight", "show search button when selecting text"],
        },
      },
    },
    {
      section: "Passwords and autofill",
      rows: {
        passwordManager: {
          title: t("Password manager"),
          description: t("Ardia's own, a plugin, or none for an extension."),
          keywords: ["password manager", "passwords app", "passkeys", "verification codes", "2fa", "one time code", "autofill passwords", "password manager plugin", "extension", "logins", "none"],
          shown: () => PLATFORM_FEATURES.systemPasswordManagers && PLATFORM_FEATURES.plugins,
        },
        offerToSavePasswords: {
          title: t("Save and fill passwords"),
          description: t("Offers to save logins and fills saved ones."),
          keywords: ["password manager", "logins", "credentials", "keychain", "offer to save and fill passwords"],
          shown: () => PLATFORM_FEATURES.passwordAutofillSwitch,
        },
        passwords: {
          title: t("Passwords"),
          description: t("Saved passwords, import and export."),
          keywords: ["csv", "logins", "import passwords", "backup", "export passwords", "saved passwords", "never saved", "1password", "bitwarden", "password manager"],
        },
        addresses: {
          title: t("Save and fill addresses"),
          description: t("Names, addresses, email addresses and phone numbers."),
          keywords: ["forms", "contact", "phone", "email", "add address", "addresses"],
        },
        savedAddresses: {
          title: t("Saved addresses"),
          description: t("Names, addresses, email addresses and phone numbers."),
          keywords: ["edit address", "add address", "contact", "phone", "email"],
        },
        cards: {
          title: t("Save and fill cards"),
          explained: true,
          description: `Showing or filling a card asks for ${PLATFORM_TERMS.deviceUnlock}.`,
          keywords: ["payment", "debit card", "forms", "save and fill credit cards", "credit cards"],
        },
        savedCards: {
          title: t("Saved cards"),
          keywords: ["edit card", "add card", "payment", "credit card", "debit card"],
        },
      },
    },
    {
      section: "Extensions",
      rows: {
        extensions: {
          title: t("Installed extensions"),
          description: t("From the Chrome Web Store. Each profile has its own."),
          keywords: ["add ons", "plugins", "installed", "extensions", "install extension", "url", "add from a link", "developer mode", "load unpacked extension"],
        },
        webStore: {
          title: t("Get extensions"),
          description: t("Add to Ardia installs into this profile."),
          keywords: ["install extension", "chrome web store"],
        },
      },
    },
    {
      section: "Data",
      rows: {
        exportBookmarks: {
          title: t("Export bookmarks"),
          description: t("As an HTML file any browser can import."),
          keywords: ["backup", "html", "netscape", "bookmarks.html", "save bookmarks", "transfer"],
          shown: () => PLATFORM_FEATURES.exportsBookmarksAndPasswords,
        },
        clearBrowsingData: {
          title: t("Clear browsing data"),
          keywords: ["clear history", "cookies", "cache", "delete data"],
        },
      },
    },
    {
      section: "For all profiles",
      rows: {
        defaultProfile: {
          title: t("Default profile"),
          description: t("Used for new windows."),
          keywords: ["new window"],
        },
        showProfileDots: {
          title: t("Show the profile switcher in the sidebar"),
          explained: true,
          description: t("A dot for each profile, or its icon if you gave it one."),
          keywords: ["dots", "pager", "profile switcher", "page dots", "sidebar footer", "hide", "show profile dots", "spaces", "space icons", "profile dots", "switcher", "emoji", "symbol", "arc", "show profile icons instead of dots", "profile icons", "switcher in the sidebar shows", "nothing"],
        },
        shareTopApps: {
          title: t("Share Top Apps"),
          keywords: ["pinned tabs", "favorites", "essentials", "spaces", "shared"],
        },
        spacesFollowAppearance: {
          title: t("Profile colors follow the theme"),
          explained: true,
          description: t("Every profile follows this, whatever its theme says."),
          keywords: ["space", "profile theme", "arc theme", "follow system", "profile themes follow this appearance"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "profiles">;
