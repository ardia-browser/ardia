import { type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";

const webKitOffered = () => PLATFORM_FEATURES.webKit;

export const advancedRows = {
  advanced: [
    {
      section: "Browsing",
      rows: {
        showFullUrl: {
          title: "Show full URL in the address bar",
          description: "Instead of the site alone.",
          keywords: ["address", "url", "https"],
        },
        chromeSettings: {
          title: "Chromium settings",
          explained: true,
          description: "Chrome's own settings, for zoom, fonts, languages and more.",
          keywords: ["chrome://settings", "zoom", "page zoom", "font", "font size", "fonts", "accessibility", "languages", "default zoom", "chrome settings"],
        },
      },
    },
    {
      section: "Performance",
      rows: {
        memorySaver: {
          title: "Memory Saver",
          explained: true,
          description: "How hard Ardia works to free memory.",
          keywords: ["sleep", "sleeping tabs", "tab sleeping", "discard", "hibernate", "memory", "ram", "inactive tabs", "unload", "suspend", "performance", "moderate", "balanced", "maximum", "memory savings", "profiles", "launch", "extensions", "lazy", "defer", "load profiles when opened", "idle", "inactive", "timeout", "unload inactive profiles"],
        },
        keepActiveSites: {
          title: "Keep these sites awake",
          explained: true,
          description: "These sites never go to sleep.",
          keywords: ["sleep", "never sleep", "keep awake", "exceptions", "discard", "hibernate", "memory saver", "memory", "always keep these sites active"],
          shown: (s) => s.memorySaver,
          needs: "Turn on Memory Saver to use this",
        },
        batterySaver: {
          title: "Battery Saver",
          keywords: ["energy", "energy saver", "low power mode", "performance", "power"],
        },
      },
    },
    {
      section: "Web engine",
      rows: {
        pageEngine: {
          title: "Open pages in",
          explained: true,
          description: "Unless a website rule says otherwise.",
          keywords: ["engine", "webkit", "chromium", "safari", "drm", "netflix", "fairplay", "widevine", "reset", "recommended", "use recommended default", "cookies", "site data", "sign in", "logged out", "separate sign-ins", "extensions", "ad blocker", "ublock", "content blocker", "extensions and ad blocking are chromium only", "passkey", "webauthn", "icloud keychain", "passwords app", "security key", "passkeys"],
          shown: webKitOffered,
        },
        fairPlayInChromium: {
          title: "FairPlay in Chromium",
          explained: true,
          description: "Plays FairPlay sites like Spotify in Chromium instead of WebKit.",
          keywords: ["fairplay", "spotify", "drm", "chromium", "helper", "protected", "music", "video", "streaming", "play protected media in chromium with fairplay"],
          shown: webKitOffered,
        },
        websiteEngines: {
          title: "Engine per site",
          description: "Sites that always open in a chosen engine.",
          keywords: ["opens in", "site engine", "rule", "webkit", "chromium", "website rules", "drm", "netflix", "disney", "hbo", "max", "prime video", "hulu", "spotify", "apple tv", "apple music", "fairplay", "widevine", "streaming", "tencent video", "v.qq.com", "open streaming sites in webkit"],
          shown: webKitOffered,
        },
      },
    },
    {
      section: "Command line and automation",
      rows: {
        ardiaCommand: {
          title: "ardia command",
          keywords: ["cli", "command line", "terminal", "shell", "install", "the ardia command", "devtools", "automation", "remote debugging", "let the ardia command control ardia"],
          shown: () => PLATFORM_FEATURES.ardiaCommand,
        },
        compactCliPill: {
          title: "Show the control pill as an icon and Stop",
          explained: true,
          description: "While a command drives Ardia, the pill shows just an icon and Stop.",
          keywords: ["cli", "control pill", "is controlling", "agent", "claude code", "codex", "hide", "smaller", "compact", "minimize", "indicator", "stop"],
          shown: () => PLATFORM_FEATURES.ardiaCommand,
        },
        automationRules: {
          title: "Automation rules",
          explained: true,
          description: "Rules from hooks.json and config.json stay off until you approve them.",
          keywords: ["hooks", "hooks.json", "approve", "launchActions", "address bar providers", "rules"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "advanced">;
