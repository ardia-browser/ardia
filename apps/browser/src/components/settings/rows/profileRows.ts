import { type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";

export const profileRows = {
  profiles: [
    {
      section: "Profiles",
      rows: {
        list: { title: "Profiles", description: "Browsing identities and their assigned spaces", keywords: ["profile", "create profile", "new profile", "delete profile", "work", "personal"] },
      },
    },
    {
      section: "This profile",
      rows: {
        profileDownloadsFolder: {
          title: "Downloads folder",
          keywords: ["download location", "save to", "folder"],
          shown: (s) => s.separateDownloadFolders,
          needs: "Turn on Separate folder for each profile in General",
        },
        preloadPages: {
          title: "Preload pages",
          explained: true,
          description: "Links open faster, but pages you may never visit are fetched too.",
          keywords: ["preload", "prerender", "preconnect", "prefetch", "speed", "faster", "slow connection", "latency", "network predictions"],
          shown: () => PLATFORM_FEATURES.preloadPages,
        },
        siteSettings: {
          title: "Site settings",
          description: "Permissions, autoplay, notifications and zoom.",
          keywords: ["camera", "microphone", "location", "popups", "cookies", "javascript", "clear site data", "website settings", "site permissions", "autoplay", "auto play", "videos playing", "stop videos", "media autoplay", "muted autoplay", "block autoplay on every site", "push notifications", "notification prompts", "notification requests", "stop asking", "notification spam", "block requests to send notifications", "zoom levels", "permissions", "notifications"],
        },
      },
    },
    {
      section: "Search",
      rows: {
        searchEngine: {
          title: "Search engine",
          description: "Used by the command bar and the New Tab page.",
          keywords: ["google", "duckduckgo", "bing", "kagi", "ecosia", "default search engine"],
        },
        otherEngines: {
          title: "Other search engines",
          description: "Type a shortcut and press Tab to search a site directly.",
          keywords: ["custom search", "site search", "keyword"],
        },
        suggestWhileTyping: {
          title: "Suggest while typing",
          explained: true,
          description: "Searches and pages from your history.",
          keywords: ["autocomplete", "show search suggestions", "history", "visited pages", "browsing history", "hide history", "autofill", "inline completion", "recent pages", "command bar", "omnibox", "suggest pages from history", "search suggestions", "history suggestions"],
        },
        showSelectionSearch: {
          title: "Search button on selected text",
          description: "Shows a Search button over text you select.",
          keywords: ["selection", "selected text", "popover", "popup", "highlight", "show search button when selecting text"],
        },
      },
    },
    {
      section: "Passwords and autofill",
      rows: {
        passwordManager: {
          title: "Password manager",
          description: "Ardia's own, a password manager plugin, or none when an extension handles logins.",
          keywords: ["password manager", "passwords app", "passkeys", "verification codes", "2fa", "one time code", "autofill passwords"],
          shown: () => PLATFORM_FEATURES.systemPasswordManagers && PLATFORM_FEATURES.plugins,
        },
        offerToSavePasswords: {
          title: "Save and fill passwords",
          description: "Offers to save logins and fills saved ones.",
          keywords: ["password manager", "logins", "credentials", "keychain", "offer to save and fill passwords"],
          shown: () => PLATFORM_FEATURES.passwordAutofillSwitch,
        },
        passwords: {
          title: "Passwords",
          description: "Saved passwords, import and export.",
          keywords: ["csv", "logins", "import passwords", "backup", "export passwords", "saved passwords", "never saved", "1password", "bitwarden", "password manager"],
        },
        addresses: {
          title: "Save and fill addresses",
          description: "Names, addresses, email addresses and phone numbers.",
          keywords: ["forms", "contact", "phone", "email", "add address", "addresses"],
        },
        savedAddresses: {
          title: "Saved addresses",
          description: "Names, addresses, email addresses and phone numbers.",
          keywords: ["edit address", "add address", "contact", "phone", "email"],
        },
        cards: {
          title: "Save and fill cards",
          explained: true,
          description: `Showing or filling a card asks for ${PLATFORM_TERMS.deviceUnlock}.`,
          keywords: ["payment", "debit card", "forms", "save and fill credit cards", "credit cards"],
        },
        savedCards: {
          title: "Saved cards",
          keywords: ["edit card", "add card", "payment", "credit card", "debit card"],
        },
      },
    },
    {
      section: "Extensions",
      rows: {
        extensions: {
          title: "Installed extensions",
          description: "From the Chrome Web Store. Each profile has its own.",
          keywords: ["add ons", "plugins", "installed", "extensions", "install extension", "url", "add from a link", "developer mode", "load unpacked extension"],
        },
        webStore: {
          title: "Get extensions",
          description: "Add to Ardia installs into this profile.",
          keywords: ["install extension", "chrome web store"],
        },
      },
    },
    {
      section: "Data",
      rows: {
        exportBookmarks: {
          title: "Export bookmarks",
          description: "As an HTML file any browser can import.",
          keywords: ["backup", "html", "netscape", "bookmarks.html", "save bookmarks", "transfer"],
          shown: () => PLATFORM_FEATURES.exportsBookmarksAndPasswords,
        },
        clearBrowsingData: {
          title: "Clear browsing data",
          keywords: ["clear history", "cookies", "cache", "delete data"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "profiles">;
