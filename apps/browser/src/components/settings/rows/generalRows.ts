import { APP, ENGINE_MODE_ROW, WEBKIT_LIMITS_KEYWORDS, type SettingsEnv, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { keyText } from "../../../state/commands/keyText";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { t } from "../../../lib/uiLanguage";


const inSidebar = (_: unknown, env: SettingsEnv) => !env.top;
const syncOn = (_: unknown, env: SettingsEnv) => !!env.syncOn;
const blockerOffered = () => PLATFORM_FEATURES.contentBlocker;

export const generalRows = {
  general: [
    {
      section: t(`Default browser`),
      rows: {
        defaultBrowser: {
          title: t(`Default browser`),
          description: `Make ${APP} your default browser.`,
          keywords: ["default", t(`set as default`), "links"],
        },
      },
    },
    {
      section: t(`Startup and quitting`),
      rows: {
        openAtLogin: {
          title: `Open ${APP} at login`,
          keywords: ["startup", "launch", t(`login items`), "boot"],
        },
        windowsAndTabs: {
          title: t(`When Ardia quits`),
          description: `What you see the next time you open it. ${PLATFORM_FEATURES.menuBar ? "Closed windows stay in History › Recently Closed." : `${keyText("⇧⌘T")} reopens closed windows too.`}`,
          keywords: ["restore", "session", "reopen", t(`preserve tabs`), t(`start fresh`), t(`windows and tabs`)],
        },
        askBefore: {
          title: t(`Ask before`),
          description: t(`Ardia asks before doing any of these.`),
          keywords: ["quit", "confirm", t(`cmd q`), t(`last window`), "exit", t(`warn before quitting`), t(`close window`), t(`warn before closing a window with multiple tabs`), t(`close tab`), t(`warn before closing last tab in a profile`), t(`close group`), "folder", "accidentally", t(`warn before closing a tab group`), t(`warn before moving tabs between profiles`), "warn", t(`last tab`), t(`move tab`)],
        },
      },
    },
    {
      section: t(`Web engine`),
      rows: {
        engineMode: { ...ENGINE_MODE_ROW, keywords: [...ENGINE_MODE_ROW.keywords, ...WEBKIT_LIMITS_KEYWORDS], shown: () => PLATFORM_FEATURES.webKit },
      },
    },
    {
      section: t(`Downloads`),
      rows: {
        downloadsFolder: {
          title: t(`Downloads folder`),
          description: t(`Where downloaded files are saved.`),
          keywords: [t(`download location`), t(`save to`), "path", "folder"],
          shown: (s) => !s.separateDownloadFolders,
          needs: t(`Turn off Separate folder for each profile to set one folder here`),
        },
        separateDownloadFolders: {
          title: t(`Separate folder for each profile`),
          description: t(`Each profile saves to its own folder.`),
          keywords: [t(`all profiles`), "global", t(`download location`), t(`use these settings for every profile`), t(`per profile`)],
        },
        askWhereToSave: {
          title: t(`Ask where to save each file`),
          keywords: [t(`download location`), t(`save as`), "prompt", t(`choose folder`)],
        },
      },
    },
    {
      section: t(`Content blocking`),
      rows: {
        blockAds: {
          title: t(`Block ads`),
          keywords: [t(`ad blocker`), "adblock", t(`ublock origin`), "easylist"],
          shown: blockerOffered,
        },
        blockTrackers: {
          title: t(`Block trackers`),
          keywords: ["tracking", "easyprivacy", "fingerprinting"],
          shown: blockerOffered,
        },
        blockCookieBanners: {
          title: t(`Block cookie banners`),
          keywords: ["cookies", "consent", "gdpr", "popups"],
          shown: blockerOffered,
        },
        filterLists: {
          title: t(`Filter lists`),
          explained: true,
          description: t(`Extra filter lists for the blocker.`),
          keywords: [t(`filter lists`), "annoyances", "malware", "regional", t(`ad block settings`), t(`custom filter list`), t(`add filter list`), t(`import list`), "subscribe", t(`advanced settings`), t(`sites without blocking`), "allowlist", "exceptions", t(`hidden elements`), t(`hide element`)],
          shown: blockerOffered,
        },
      },
    },
    {
      section: t(`Sync`),
      rows: {
        sync: {
          title: t(`Sync`),
          explained: true,
          description: `Keep your profiles, tabs and settings the same on every ${PLATFORM_TERMS.syncedComputer}.`,
          keywords: [PLATFORM_TERMS.cloudDrive.toLowerCase(), t(`recovery phrase`), "devices", t(`turn on sync`), t(`end to end`), "encrypted"],
        },
        syncFolder: {
          title: t(`Sync folder`),
          keywords: [t(`icloud drive`), "dropbox", "folder"],
          shown: syncOn,
          needs: t(`Turn on Sync to use this`),
        },
        whatSyncs: {
          title: t(`What syncs`),
          description: t(`What to sync.`),
          keywords: [t(`unpinned tabs`), t(`regular tabs`), t(`today tabs`), "arc", "spaces", `tabs on every ${PLATFORM_TERMS.syncedComputer.toLowerCase()}`, t(`same tabs`), `continue on another ${PLATFORM_TERMS.syncedComputer.toLowerCase()}`, t(`sync all open tabs`), t(`open tabs`), t(`data types`)],
          shown: syncOn,
          needs: t(`Turn on Sync to use this`),
        },
        syncDevices: {
          title: t(`Devices`),
          description: t(`Computers syncing with this one.`),
          keywords: ["devices", "computers", "macs", t(`remove device`)],
          shown: syncOn,
          needs: t(`Turn on Sync to use this`),
        },
      },
    },
    {
      section: t(`Updates`),
      rows: {
        autoUpdate: {
          title: t(`Install updates automatically`),
          explained: true,
          description: t(`Installs updates on the next restart.`),
          keywords: ["update", "install", "sparkle", t(`check for updates automatically`), t(`automatic updates`)],
        },
        updateChannel: {
          title: t(`Update channel`),
          explained: true,
          description: t(`Nightly gets fixes first.`),
          keywords: ["nightly", "stable", "beta"],
        },
        version: {
          title: t(`Version`),
          keywords: ["version", "update", "about", t(`check for updates now`), "engine", "ardiacore", "chromium", "drm", "netflix", "disney", "github", t(`open source`), "gpl", "license", t(`source code`), "credits", "legal", "licenses", t(`check for updates`), t(`chromium version`), "widevine"],
        },
      },
    },
    {
      section: t(`Crash reports`),
      rows: {
        shareDiagnostics: {
          title: t(`Share anonymous crash reports`),
          keywords: ["telemetry", "analytics", "diagnostics", "crash", t(`share anonymous crash reports and usage stats`)],
        },
        crashDetails: {
          title: t(`Details`),
          description: t(`What's sent and what's kept on this computer.`),
          keywords: ["telemetry", t(`data collection`), "analytics", t(`usage data`), t(`what's sent`), t(`install id`), "identity", t(`reset id`), "avatar", t(`anonymous name`), t(`your anonymous id`), t(`view my data`), t(`local copy`), "export", t(`download my data`), t(`telemetry log`), "diagnostics", "events", t(`the last 7 days`), t(`whats sent`), t(`anonymous id`), "logs", "privacy"],
        },
      },
    },
    {
      section: t(`Import`),
      rows: {
        importBrowser: {
          title: t(`Import from another browser`),
          description: `From Chrome, Arc, ${PLATFORM_FEATURES.hiddenBrowserSources.includes("safari") ? "Edge" : "Safari"}, Firefox and more.`,
          keywords: ["migrate", "switch", "transfer", t(`import from another browser`), t(`setup code`), "demo", "ardia.dev", "preset", "arc", "layout", t(`apply a setup code`)],
        },
        redoSetup: {
          title: `Set up ${APP} again`,
          explained: true,
          description: t(`Run setup again, starting from your current settings.`),
          keywords: ["onboarding", "setup", "redo", "welcome", t(`start over`), "walkthrough", t(`first run`)],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "general">;
