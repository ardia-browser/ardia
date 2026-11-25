import { t } from "../../../lib/i18n";
import { APP, ENGINE_MODE_ROW, WEBKIT_LIMITS_KEYWORDS, type SettingsEnv, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";

const syncOn = (_: unknown, env: SettingsEnv) => !!env.syncOn;
const blockerOffered = () => PLATFORM_FEATURES.contentBlocker;

export const generalRows = {
  general: [
    {
      section: "Default browser",
      rows: {
        defaultBrowser: {
          title: t("Default browser"),
          description: t("Make {app} your default browser.", { app: APP }),
          keywords: ["default", "set as default", "links"],
        },
      },
    },
    {
      section: "Startup and quitting",
      rows: {
        openAtLogin: {
          title: t("Open {app} at login", { app: APP }),
          keywords: ["startup", "launch", "login items", "boot"],
        },
        windowsAndTabs: {
          title: t("When Ardia quits"),
          description: `What you see the next time you open it. ${PLATFORM_FEATURES.menuBar ? "Closed windows stay in History › Recently Closed." : `${keyText("⇧⌘T")} reopens closed windows too.`}`,
          keywords: ["restore", "session", "reopen", "preserve tabs", "start fresh", "windows and tabs"],
        },
        askBefore: {
          title: t("Ask before"),
          description: t("Ardia asks before doing any of these."),
          keywords: ["quit", "confirm", "cmd q", "last window", "exit", "warn before quitting", "close window", "warn before closing a window with multiple tabs", "close tab", "warn before closing last tab in a profile", "close group", "folder", "accidentally", "warn before closing a tab group", "warn before moving tabs between profiles", "warn", "last tab", "move tab"],
        },
      },
    },
    {
      section: "Web engine",
      rows: {
        engineMode: { ...ENGINE_MODE_ROW, keywords: [...ENGINE_MODE_ROW.keywords, ...WEBKIT_LIMITS_KEYWORDS], shown: () => PLATFORM_FEATURES.webKit },
      },
    },
    {
      section: "Downloads",
      rows: {
        downloadsFolder: {
          title: t("Downloads folder"),
          description: t("Where downloaded files are saved."),
          keywords: ["download location", "save to", "path", "folder"],
          shown: (s) => !s.separateDownloadFolders,
          needs: t("Turn off Separate folder for each profile to set one folder here"),
        },
        separateDownloadFolders: {
          title: t("Separate folder for each profile"),
          description: t("Each profile saves to its own folder."),
          keywords: ["all profiles", "global", "download location", "use these settings for every profile", "per profile"],
        },
        askWhereToSave: {
          title: t("Ask where to save each file"),
          keywords: ["download location", "save as", "prompt", "choose folder"],
        },
      },
    },
    {
      section: "Content blocking",
      rows: {
        blockAds: {
          title: t("Block ads"),
          keywords: ["ad blocker", "adblock", "ublock origin", "easylist"],
          shown: blockerOffered,
        },
        blockTrackers: {
          title: t("Block trackers"),
          keywords: ["tracking", "easyprivacy", "fingerprinting"],
          shown: blockerOffered,
        },
        blockCookieBanners: {
          title: t("Block cookie banners"),
          keywords: ["cookies", "consent", "gdpr", "popups"],
          shown: blockerOffered,
        },
        filterLists: {
          title: t("Filter lists"),
          explained: true,
          description: t("Extra filter lists for the blocker."),
          keywords: ["filter lists", "annoyances", "malware", "regional", "ad block settings", "custom filter list", "add filter list", "import list", "subscribe", "advanced settings", "sites without blocking", "allowlist", "exceptions", "hidden elements", "hide element"],
          shown: blockerOffered,
        },
      },
    },
    {
      section: "Sync",
      rows: {
        sync: {
          title: t("Sync"),
          explained: true,
          description: t("Keep your profiles, tabs and settings the same on every {computer}.", { computer: PLATFORM_TERMS.syncedComputer }),
          keywords: [PLATFORM_TERMS.cloudDrive.toLowerCase(), "recovery phrase", "devices", "turn on sync", "end to end", "encrypted"],
        },
        syncFolder: {
          title: t("Sync folder"),
          keywords: ["icloud drive", "dropbox", "folder"],
          shown: syncOn,
          needs: t("Turn on Sync to use this"),
        },
        whatSyncs: {
          title: t("What syncs"),
          description: t("What to sync."),
          keywords: ["unpinned tabs", "regular tabs", "today tabs", "arc", "spaces", `tabs on every ${PLATFORM_TERMS.syncedComputer.toLowerCase()}`, "same tabs", `continue on another ${PLATFORM_TERMS.syncedComputer.toLowerCase()}`, "sync all open tabs", "open tabs", "data types"],
          shown: syncOn,
          needs: t("Turn on Sync to use this"),
        },
        syncDevices: {
          title: t("Devices"),
          description: t("Computers syncing with this one."),
          keywords: ["devices", "computers", "macs", "remove device"],
          shown: syncOn,
          needs: t("Turn on Sync to use this"),
        },
      },
    },
    {
      section: "Updates",
      rows: {
        autoUpdate: {
          title: t("Install updates automatically"),
          explained: true,
          description: t("Installs updates on the next restart."),
          keywords: ["update", "install", "sparkle", "check for updates automatically", "automatic updates"],
        },
        updateChannel: {
          title: t("Update channel"),
          explained: true,
          description: t("Nightly gets fixes first."),
          keywords: ["nightly", "stable", "beta"],
        },
        version: {
          title: t("Version"),
          keywords: ["version", "update", "about", "check for updates now", "engine", "ardiacore", "chromium", "drm", "netflix", "disney", "github", "open source", "gpl", "license", "source code", "credits", "legal", "licenses", "check for updates", "chromium version", "widevine"],
        },
      },
    },
    {
      section: "Crash reports",
      rows: {
        shareDiagnostics: {
          title: t("Share anonymous crash reports"),
          keywords: ["telemetry", "analytics", "diagnostics", "crash", "share anonymous crash reports and usage stats"],
        },
        crashDetails: {
          title: t("Details"),
          description: t("What's sent and what's kept on this computer."),
          keywords: ["telemetry", "data collection", "analytics", "usage data", "what's sent", "install id", "identity", "reset id", "avatar", "anonymous name", "your anonymous id", "view my data", "local copy", "export", "download my data", "telemetry log", "diagnostics", "events", "the last 7 days", "whats sent", "anonymous id", "logs", "privacy"],
        },
      },
    },
    {
      section: "Import",
      rows: {
        importBrowser: {
          title: t("Import from another browser"),
          description: `From Chrome, Arc, ${PLATFORM_FEATURES.hiddenBrowserSources.includes("safari") ? "Edge" : "Safari"}, Firefox and more.`,
          keywords: ["migrate", "switch", "transfer", "import from another browser", "setup code", "demo", "ardia.dev", "preset", "arc", "layout", "apply a setup code"],
        },
        redoSetup: {
          title: t("Set up {app} again", { app: APP }),
          explained: true,
          description: t("Run setup again, starting from your current settings."),
          keywords: ["onboarding", "setup", "redo", "welcome", "start over", "walkthrough", "first run"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "general">;
