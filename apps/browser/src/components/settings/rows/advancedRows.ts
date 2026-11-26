import { WEBKIT_LIMITS_KEYWORDS, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import type { Settings } from "../../../state/settings/settings";
import { keyText } from "../../../state/commands/keyText";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { keptSitesListed } from "../../../state/tabs/keptSites";

const webKitOffered = () => PLATFORM_FEATURES.webKit;
const automaticEngine = (s: Settings) => webKitOffered() && s.engineMode === "automatic";
const webKitInUse = (s: Settings) => webKitOffered() && s.engineMode !== "chromium";
const NEEDS_AUTOMATIC = "Set Engine to Automatic in General to use this";
const NEEDS_WEBKIT = "Set Engine to Automatic or WebKit in General to use this";

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
        commandScrollZoom: {
          title: `Zoom pages with ${keyText("⌘")}-scroll`,
          explained: true,
          description: `Sites that use ${keyText("⌘")}-scroll themselves, like maps, still get it.`,
          keywords: ["scroll wheel", "mouse wheel", "command scroll", "cmd scroll", "ctrl scroll", "mouse zoom", "wheel zoom", "accidental zoom", "page zoom", "pinch", "bettermouse"],
          shown: () => PLATFORM_FEATURES.commandScrollZoom,
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
          shown: keptSitesListed,
          needs: "Turn on Memory Saver to use this",
        },
        busyTabWarnings: {
          title: "Warn about busy background tabs",
          explained: true,
          description: "When a hidden tab keeps the processor busy for 2 minutes.",
          keywords: ["cpu", "processor", "energy", "power", "battery", "busy", "background tabs", "high cpu", "fan", "hot", "sleep tab", "keep running"],
          shown: () => PLATFORM_FEATURES.busyTabWatch,
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
          keywords: ["engine", "webkit", "chromium", "safari", "drm", "netflix", "fairplay", "widevine", "reset", "recommended", "use recommended default"],
          shown: automaticEngine,
          needs: NEEDS_AUTOMATIC,
        },
        websiteEngines: {
          title: "Engine per site",
          description: "Sites that always open in a chosen engine.",
          keywords: ["opens in", "site engine", "rule", "webkit", "chromium", "website rules", "drm", "netflix", "disney", "hbo", "max", "prime video", "hulu", "spotify", "apple tv", "apple music", "fairplay", "widevine", "streaming", "tencent video", "v.qq.com", "audible", "audiobooks", "canal+", "canalplus", "mycanal", "youtube tv", "tv.youtube.com", "osn+", "osnplus", "anghami", "open streaming sites in webkit"],
          shown: automaticEngine,
          needs: NEEDS_AUTOMATIC,
        },
        offerWebKitForProtectedVideo: {
          title: "Offer WebKit when a video won't play",
          explained: true,
          description: "When a Chromium page can't play protected video, Ardia offers to open it in WebKit.",
          keywords: ["drm", "protected video", "prompt", "open in webkit", "fairplay", "streaming", "stay on page", "drm prompt"],
          shown: automaticEngine,
          needs: NEEDS_AUTOMATIC,
        },
      },
    },
    {
      section: "Switching engines",
      rows: {
        engineSwitchKeepsPage: {
          title: "Keep the page on screen while it switches",
          explained: true,
          description: "The old page stays up until the other engine draws it, up to 3 seconds.",
          keywords: ["seamless", "swap", "flash", "blank", "reload", "scroll position", "same scroll position", "switch engine", "switching engines", "open in webkit", "open in chromium", "3 seconds", "drawn"],
          shown: webKitOffered,
        },
        engineSwitchAsksAboutUnsavedWork: {
          title: "Ask before reloading a page you've typed in",
          explained: true,
          description: "Switching engines reloads the page, which can lose unsent text.",
          keywords: ["unsaved", "form", "input", "confirm", "warn", "stay on page", "switch engine", "switching engines", "text you haven't sent", "lost"],
          shown: webKitOffered,
        },
        engineSwitchCarriesSiteData: {
          title: "Bring sign-ins along",
          explained: true,
          description: "A switching page takes its cookies along, so you stay signed in.",
          keywords: ["bring sign-ins", "cookies", "site data", "sign in", "logged out", "local storage", "session", "switch engine", "separate sign-ins", "saved data", "stay signed in"],
          shown: webKitOffered,
        },
      },
    },
    {
      section: "WebKit pages",
      rows: {
        webKitFraudWarnings: {
          title: "Warn about fraudulent websites",
          explained: true,
          description: "WebKit pages warn before a deceptive site opens.",
          keywords: ["safe browsing", "phishing", "malware", "fraud", "deceptive", "security", "warning", "google", "tencent", "safe browsing lists", "addresses"],
          shown: webKitInUse,
          needs: NEEDS_WEBKIT,
        },
        enginesDiffer: {
          title: "How engines differ",
          explained: true,
          description: "Sign-ins, passkeys, and what WebKit pages can't do.",
          keywords: ["cookies", "site data", "sign in", "logged out", "separate sign-ins", "extensions", "ad blocker", "ublock", "content blocker", "passkey", "webauthn", "icloud keychain", "passwords app", "security key", "passkeys", "widevine", "streaming", ...WEBKIT_LIMITS_KEYWORDS],
          shown: webKitInUse,
          needs: NEEDS_WEBKIT,
        },
      },
    },
    {
      section: "Command line and automation",
      rows: {
        programControl: {
          title: "Let programs control Ardia",
          explained: true,
          description: "Programs like the ardia command can act in your signed-in pages.",
          keywords: ["control", "cli", "automation", "agent", "stop", "turn control back on", "devtools", "remote debugging", "control pill", "let the ardia command control ardia", "programs you run", "open", "read", "logins", "ardia command"],
          shown: () => PLATFORM_FEATURES.plugins,
        },
        allowedPrograms: {
          title: "Programs you let in",
          explained: true,
          description: "A program that isn't part of Ardia asks before it can control Ardia. The ones you allowed for 30 minutes or always are listed here.",
          keywords: ["control", "socket", "allow", "always allow", "doorbell", "revoke", "programs", "agent", "script", "python", "cli", "permission"],
          shown: () => PLATFORM_FEATURES.controlDoorbell,
        },
        programs: {
          title: "Programs on your PATH",
          keywords: ["cli", "command line", "terminal", "shell", "path", "programs", "commands", "plugin programs", "try again", "relink"],
          shown: () => PLATFORM_FEATURES.plugins,
        },
        ardiaCommand: {
          title: "ardia command",
          keywords: ["cli", "command line", "terminal", "shell", "install", "the ardia command", "devtools", "automation", "remote debugging", "let the ardia command control ardia"],
          shown: () => PLATFORM_FEATURES.ardiaCommand && !PLATFORM_FEATURES.plugins,
        },
        compactCliPill: {
          title: "Show the control pill as an icon and Stop",
          explained: true,
          description: "While a program drives Ardia, the pill shows just an icon and Stop.",
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
