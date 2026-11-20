import { APP, type SettingsEnv, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";

const inSidebar = (_: unknown, env: SettingsEnv) => !env.top;
const syncOn = (_: unknown, env: SettingsEnv) => !!env.syncOn;
const syncOffered = () => PLATFORM_FEATURES.sync;
const syncSettingsOffered = (env: SettingsEnv) => PLATFORM_FEATURES.sync && env.syncAvailable !== false;
const blockerOffered = () => PLATFORM_FEATURES.contentBlocker;

export const generalRows = {
  general: [
    {
      section: "Default browser",
      rows: {
        defaultBrowser: {
          title: "Default browser",
          description: `Make ${APP} your default browser.`,
          keywords: ["default", "set as default", "links"],
        },
      },
    },
    {
      section: "Startup and quitting",
      rows: {
        openAtLogin: {
          title: `Open ${APP} at login`,
          keywords: ["startup", "launch", "login items", "boot"],
        },
        windowsAndTabs: {
          title: "When Ardia quits",
          description: `What you see the next time you open it. ${PLATFORM_FEATURES.menuBar ? "Closed windows stay in History › Recently Closed." : `${keyText("⇧⌘T")} reopens closed windows too.`}`,
          keywords: ["restore", "session", "reopen", "preserve tabs", "start fresh", "windows and tabs"],
        },
        askBefore: {
          title: "Ask before",
          description: "Ardia asks before doing any of these.",
          keywords: ["quit", "confirm", "cmd q", "last window", "exit", "warn before quitting", "close window", "warn before closing a window with multiple tabs", "close tab", "warn before closing last tab in a profile", "close group", "folder", "accidentally", "warn before closing a tab group", "warn before moving tabs between profiles", "warn", "last tab", "move tab"],
        },
      },
    },
    {
      section: "Downloads",
      rows: {
        downloadsFolder: {
          title: "Default downloads folder",
          description: "Where downloaded files are saved.",
          keywords: ["download location", "save to", "path", "folder"],
          shown: (s) => !s.separateDownloadFolders,
          needs: "Turn off Separate folder for each profile to set one folder here",
          unlock: "general.separateDownloadFolders",
        },
        separateDownloadFolders: {
          title: "Separate folder for each profile",
          description: "Each profile saves to its own folder.",
          keywords: ["all profiles", "global", "download location", "use these settings for every profile", "per profile"],
        },
        askWhereToSave: {
          title: "Ask where to save each file",
          keywords: ["download location", "save as", "prompt", "choose folder"],
        },
      },
    },
    {
      section: "Content blocking",
      rows: {
        blockAds: {
          title: "Block ads",
          keywords: ["ad blocker", "adblock", "ublock origin", "easylist"],
          offered: blockerOffered,
        },
        blockTrackers: {
          title: "Block trackers",
          keywords: ["tracking", "easyprivacy", "fingerprinting"],
          offered: blockerOffered,
        },
        blockCookieBanners: {
          title: "Block cookie banners",
          keywords: ["cookies", "consent", "gdpr", "popups"],
          offered: blockerOffered,
        },
        filterLists: {
          title: "Filter lists",
          explained: true,
          description: "Extra filter lists for the blocker.",
          keywords: ["filter lists", "annoyances", "malware", "regional", "ad block settings", "custom filter list", "add filter list", "import list", "subscribe", "advanced settings", "sites without blocking", "allowlist", "exceptions", "hidden elements", "hide element"],
          offered: blockerOffered,
        },
      },
    },
    {
      section: "Sync",
      rows: {
        sync: {
          title: "Sync",
          explained: true,
          description: `Keep your profiles, tabs and settings the same on every ${PLATFORM_TERMS.syncedComputer}.`,
          keywords: [PLATFORM_TERMS.cloudDrive.toLowerCase(), "recovery phrase", "devices", "turn on sync", "end to end", "encrypted"],
          offered: syncOffered,
        },
        syncFolder: {
          title: "Sync folder",
          keywords: ["icloud drive", "dropbox", "folder"],
          offered: syncSettingsOffered,
          shown: syncOn,
          needs: "Turn on Sync to use this",
          unlock: "general.sync",
        },
        whatSyncs: {
          title: "What syncs",
          description: "What to sync.",
          keywords: ["unpinned tabs", "regular tabs", "today tabs", "arc", "spaces", `tabs on every ${PLATFORM_TERMS.syncedComputer.toLowerCase()}`, "same tabs", `continue on another ${PLATFORM_TERMS.syncedComputer.toLowerCase()}`, "sync all open tabs", "open tabs", "data types"],
          offered: syncSettingsOffered,
          shown: syncOn,
          needs: "Turn on Sync to use this",
          unlock: "general.sync",
        },
        syncDevices: {
          title: "Devices",
          description: "Computers syncing with this one.",
          keywords: ["devices", "computers", "macs", "remove device"],
          offered: syncSettingsOffered,
          shown: syncOn,
          needs: "Turn on Sync to use this",
          unlock: "general.sync",
        },
      },
    },
    {
      section: "Updates",
      rows: {
        autoUpdate: {
          title: "Install updates automatically",
          explained: true,
          description: "Installs updates on the next restart.",
          keywords: ["update", "install", "sparkle", "check for updates automatically", "automatic updates"],
          capability: "updates",
        },
        updateChannel: {
          title: "Update channel",
          explained: true,
          description: "Nightly gets fixes first.",
          keywords: ["nightly", "stable", "beta"],
          capability: "updateChannel",
        },
        version: {
          title: "Version",
          keywords: ["version", "update", "about", "check for updates now", "engine", "ardiacore", "chromium", "drm", "netflix", "disney", "widevine (protected video)", "github", "open source", "gpl", "license", "source code", "credits", "legal", "licenses", "check for updates", "chromium version", "widevine"],
        },
      },
    },
    {
      section: "Crash reports",
      rows: {
        shareDiagnostics: {
          title: "Share anonymous crash reports",
          keywords: ["telemetry", "analytics", "diagnostics", "crash", "share anonymous crash reports and usage stats"],
        },
        crashDetails: {
          title: "What's sent and kept",
          description: "What's sent and what's kept on this computer.",
          keywords: ["telemetry", "data collection", "analytics", "usage data", "details", "crash report details", "what's sent", "install id", "identity", "reset id", "avatar", "anonymous name", "your anonymous id", "view my data", "local copy", "export", "download my data", "telemetry log", "diagnostics", "events", "the last 7 days", "whats sent", "anonymous id", "logs", "privacy"],
        },
      },
    },
    {
      section: "Import",
      rows: {
        importBrowser: {
          title: "Import from another browser",
          description: `From Chrome, Arc, ${PLATFORM_FEATURES.hiddenBrowserSources.includes("safari") ? "Edge" : "Safari"}, Firefox and more.`,
          keywords: ["migrate", "switch", "transfer", "import from another browser", "setup code", "demo", "ardia.dev", "preset", "arc", "layout", "apply a setup code"],
        },
        redoSetup: {
          title: `Set up ${APP} again`,
          explained: true,
          description: "Run setup again, starting from your current settings.",
          keywords: ["onboarding", "setup", "redo", "welcome", "start over", "walkthrough", "first run"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "general">;
