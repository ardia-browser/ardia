import { WEBKIT_LIMITS_KEYWORDS, type SettingSection } from "./types";
import type { SettingsPane } from "../../../state/settings/settingsWindows";
import type { Settings } from "../../../state/settings/settings";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { t } from "../../../lib/uiLanguage";


const webKitOffered = () => PLATFORM_FEATURES.webKit;
const automaticEngine = (s: Settings) => webKitOffered() && s.engineMode === "automatic";
const webKitInUse = (s: Settings) => webKitOffered() && s.engineMode !== "chromium";
const NEEDS_AUTOMATIC = t(`Set Engine to Automatic in General to use this`);
const NEEDS_WEBKIT = t(`Set Engine to Automatic or WebKit in General to use this`);

export const advancedRows = {
  advanced: [
    {
      section: t(`Browsing`),
      rows: {
        showFullUrl: {
          title: t(`Show full URL in the address bar`),
          description: t(`Instead of the site alone.`),
          keywords: ["address", "url", "https"],
        },
        chromeSettings: {
          title: t(`Chromium settings`),
          explained: true,
          description: t(`Chrome's own settings, for zoom, fonts, languages and more.`),
          keywords: ["chrome://settings", "zoom", t(`page zoom`), "font", t(`font size`), "fonts", "accessibility", "languages", t(`default zoom`), t(`chrome settings`)],
        },
      },
    },
    {
      section: t(`Performance`),
      rows: {
        memorySaver: {
          title: t(`Memory Saver`),
          explained: true,
          description: t(`How hard Ardia works to free memory.`),
          keywords: ["sleep", t(`sleeping tabs`), t(`tab sleeping`), "discard", "hibernate", "memory", "ram", t(`inactive tabs`), "unload", "suspend", "performance", "moderate", "balanced", "maximum", t(`memory savings`), "profiles", "launch", "extensions", "lazy", "defer", t(`load profiles when opened`), "idle", "inactive", "timeout", t(`unload inactive profiles`)],
        },
        keepActiveSites: {
          title: t(`Keep these sites awake`),
          explained: true,
          description: t(`These sites never go to sleep.`),
          keywords: ["sleep", t(`never sleep`), t(`keep awake`), "exceptions", "discard", "hibernate", t(`memory saver`), "memory", t(`always keep these sites active`)],
          shown: (s) => s.memorySaver,
          needs: t(`Turn on Memory Saver to use this`),
        },
        batterySaver: {
          title: t(`Battery Saver`),
          keywords: ["energy", t(`energy saver`), t(`low power mode`), "performance", "power"],
        },
      },
    },
    {
      section: t(`Web engine`),
      rows: {
        pageEngine: {
          title: t(`Open pages in`),
          explained: true,
          description: t(`Unless a website rule says otherwise.`),
          keywords: ["engine", "webkit", "chromium", "safari", "drm", "netflix", "fairplay", "widevine", "reset", "recommended", t(`use recommended default`)],
          shown: automaticEngine,
          needs: NEEDS_AUTOMATIC,
        },
        websiteEngines: {
          title: t(`Engine per site`),
          description: t(`Sites that always open in a chosen engine.`),
          keywords: [t(`opens in`), t(`site engine`), "rule", "webkit", "chromium", t(`website rules`), "drm", "netflix", "disney", "hbo", "max", t(`prime video`), "hulu", "spotify", t(`apple tv`), t(`apple music`), "fairplay", "widevine", "streaming", t(`tencent video`), "v.qq.com", "audible", "audiobooks", "canal+", "canalplus", "mycanal", t(`youtube tv`), "tv.youtube.com", "osn+", "osnplus", "anghami", t(`open streaming sites in webkit`)],
          shown: automaticEngine,
          needs: NEEDS_AUTOMATIC,
        },
        offerWebKitForProtectedVideo: {
          title: t(`Offer WebKit when a video won't play`),
          explained: true,
          description: t(`When a Chromium page can't play protected video, Ardia offers to open it in WebKit.`),
          keywords: ["drm", t(`protected video`), "prompt", t(`open in webkit`), "fairplay", "streaming", t(`stay on page`), t(`drm prompt`)],
          shown: automaticEngine,
          needs: NEEDS_AUTOMATIC,
        },
      },
    },
    {
      section: t(`Switching engines`),
      rows: {
        engineSwitchKeepsPage: {
          title: t(`Keep the page on screen while it switches`),
          explained: true,
          description: t(`The old page stays up, at the same scroll position, until the other engine has drawn it, for up to 3 seconds.`),
          keywords: ["seamless", "swap", "flash", "blank", "reload", t(`scroll position`), t(`switch engine`), t(`switching engines`), t(`open in webkit`), t(`open in chromium`)],
          shown: webKitOffered,
        },
        engineSwitchAsksAboutUnsavedWork: {
          title: t(`Ask before reloading a page you've typed in`),
          explained: true,
          description: t(`Switching engines reloads the page, so text you haven't sent can be lost.`),
          keywords: ["unsaved", "form", "input", "confirm", "warn", t(`stay on page`), t(`switch engine`), t(`switching engines`)],
          shown: webKitOffered,
        },
        engineSwitchCarriesSiteData: {
          title: t(`Bring sign-ins along`),
          explained: true,
          description: t(`A page that switches engines takes its site's cookies and saved data with it, so you stay signed in.`),
          keywords: [t(`bring sign-ins`), "cookies", t(`site data`), t(`sign in`), t(`logged out`), t(`local storage`), "session", t(`switch engine`), t(`separate sign-ins`)],
          shown: webKitOffered,
        },
      },
    },
    {
      section: t(`WebKit pages`),
      rows: {
        webKitFraudWarnings: {
          title: t(`Warn about fraudulent websites`),
          explained: true,
          description: t(`WebKit pages check addresses against Google's or Tencent's Safe Browsing lists and warn before a deceptive site opens.`),
          keywords: [t(`safe browsing`), "phishing", "malware", "fraud", "deceptive", "security", "warning"],
          shown: webKitInUse,
          needs: NEEDS_WEBKIT,
        },
        enginesDiffer: {
          title: t(`How engines differ`),
          explained: true,
          description: t(`Sign-ins, passkeys, and what WebKit pages can't do.`),
          keywords: ["cookies", t(`site data`), t(`sign in`), t(`logged out`), t(`separate sign-ins`), "extensions", t(`ad blocker`), "ublock", t(`content blocker`), "passkey", "webauthn", t(`icloud keychain`), t(`passwords app`), t(`security key`), "passkeys", "widevine", "streaming", ...WEBKIT_LIMITS_KEYWORDS],
          shown: webKitInUse,
          needs: NEEDS_WEBKIT,
        },
      },
    },
    {
      section: t(`Command line and automation`),
      rows: {
        programControl: {
          title: t(`Let programs control Ardia`),
          explained: true,
          description: t(`Programs you run, like the ardia command or an agent, can open, read and act in your pages, with your logins.`),
          keywords: ["control", "cli", "automation", "agent", "stop", t(`turn control back on`), "devtools", t(`remote debugging`), t(`control pill`), t(`let the ardia command control ardia`)],
          shown: () => PLATFORM_FEATURES.plugins,
        },
        programs: {
          title: t(`Programs on your PATH`),
          keywords: ["cli", t(`command line`), "terminal", "shell", "path", "programs", "commands", t(`plugin programs`), t(`try again`), "relink"],
          shown: () => PLATFORM_FEATURES.plugins,
        },
        ardiaCommand: {
          title: t(`ardia command`),
          keywords: ["cli", t(`command line`), "terminal", "shell", "install", t(`the ardia command`), "devtools", "automation", t(`remote debugging`), t(`let the ardia command control ardia`)],
          shown: () => PLATFORM_FEATURES.ardiaCommand && !PLATFORM_FEATURES.plugins,
        },
        compactCliPill: {
          title: t(`Show the control pill as an icon and Stop`),
          explained: true,
          description: t(`While a program drives Ardia, the pill shows just an icon and Stop.`),
          keywords: ["cli", t(`control pill`), t(`is controlling`), "agent", t(`claude code`), "codex", "hide", "smaller", "compact", "minimize", "indicator", "stop"],
          shown: () => PLATFORM_FEATURES.ardiaCommand,
        },
        automationRules: {
          title: t(`Automation rules`),
          explained: true,
          description: t(`Rules from hooks.json and config.json stay off until you approve them.`),
          keywords: ["hooks", "hooks.json", "approve", "launchActions", t(`address bar providers`), "rules"],
        },
      },
    },
  ],
} satisfies Pick<Record<SettingsPane, SettingSection[]>, "advanced">;
