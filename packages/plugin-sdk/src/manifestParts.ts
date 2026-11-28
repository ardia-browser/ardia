import { isRange, isSemver } from "./semver";
import { str, text, type Spec } from "./spec";

export const MANIFEST_V3 = 3;

export const LIMITS_V3 = {
  name: 60,
  title: 60,
  description: 200,
  pageTitle: 40,
  categories: 6,
  keywords: 12,
  keyword: 40,
  commandKeywords: 8,
  dependencies: 16,
  interfaces: 16,
  commands: 32,
  inputModes: 4,
  toolbar: 4,
  sidebarViews: 4,
  panels: 8,
  menuItems: 8,
  omnibox: 4,
  pageStyles: 16,
  contentScripts: 16,
  contentScriptFiles: 8,
  matches: 32,
  pages: 32,
  networkHosts: 32,
  themes: 8,
  hooks: 64,
  tools: 32,
  toolTimeout: [1, 300],
  programs: 4,
  rows: 20,
  choices: [2, 12],
  activationEvents: 32,
  argv: 32,
  argBytes: 1024,
  memoryMB: [64, 4096],
  idleTimeoutSec: [30, 1800],
  telemetryItems: 16,
  telemetryItem: 800,
  tooltip: 120,
  when: 200,
  example: 120,
  siteSwitches: 4,
  pageBarButtons: 16,
  switchTitle: 40,
  url: 2048,
  path: 1024,
} as const;

export const DEFAULT_IDLE_TIMEOUT_SEC = 300;

export const PLUGIN_ID_PATTERN = "^@[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9-]{0,39}$";
export const NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,39}$";
export const KEY_PATTERN = "^[A-Za-z0-9_-]{1,40}$";
export const SYMBOL_PATTERN = "^[a-z0-9.]{1,64}$";
export const SLUG_PATTERN = "^[a-z0-9][a-z0-9-]{0,31}$";
export const INTERFACE_PATTERN = "^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$";
export const EVENT_PATTERN = "^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)+$";
export const OMNIBOX_KEYWORD_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$";
export const GITHUB_REPO_PATTERN = "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$";
export const SEMVER_PATTERN =
  "^(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})\\.(0|[1-9]\\d{0,8})(?:-((?:0|[1-9]\\d{0,8}|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d{0,8}|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?$";
export const HTTPS_URL_PATTERN = "^https://[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})(?::\\d{1,5})?(?:[/?#][^\\s]*)?$";
const PLUGIN_PATH_PATTERN = "^(?![A-Za-z]:)(?![\\s\\S]*/$)(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))(?![\\s\\S]*//)[^/\\\\\\u0000-\\u001f\\u007f][^\\\\\\u0000-\\u001f\\u007f]*$";

export const PLATFORM_KEYS = ["universal", "macos-arm64", "macos-x64", "linux-x64", "linux-arm64", "windows-x64"] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export const STATE_EVENTS_V3 = ["tabs", "workspace", "navigation", "downloads", "media", "profiles"] as const;
export const STATE_INTENTS_V3 = [
  "tabs.group",
  "tabs.ungroup",
  "tabs.move",
  "tabs.pin",
  "tabs.unpin",
  "tabs.mute",
  "tabs.unmute",
  "tabs.activate",
  "groups.update",
  "splits.open",
  "peek.open",
] as const;
export const MENU_SLOTS_V3 = ["tab", "group", "page", "selection", "link", "image"] as const;
export const PANEL_MODES_V3 = ["sidecar", "tab", "split"] as const;
export const SPLIT_SIDES_V3 = ["left", "right", "top", "bottom"] as const;
export const ROW_TYPES_V3 = ["toggle", "text", "number", "choice", "secret"] as const;
export const PAGE_BAR_ACTIONS = ["siteControls", "address", "copyLink", "console", "network", "inspect", "extensions", "split"] as const;
export const PAGE_BAR_DIVIDER = "|";
export const RUN_AT = ["document_start", "document_idle"] as const;
export const ACTIVATION_PREFIXES_V3 = ["onCommand", "onView", "onPanel", "onToolbar", "onOmnibox", "onMenu", "onEvent", "onUrl", "onService", "onInputMode"] as const;

export function isPluginPath(value: string): boolean {
  if (!value || value.length > LIMITS_V3.path || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

const MODIFIERS: Record<string, string> = { cmd: "cmd", command: "cmd", ctrl: "ctrl", control: "ctrl", opt: "opt", option: "opt", alt: "opt", shift: "shift" };
const SHORTCUT_KEY = /^(?:[a-z0-9]|[-=[\]\\;',./`]|space|enter|tab|escape|up|down|left|right|f(?:[1-9]|1[0-2]))$/;
const RESERVED_SHORTCUTS = new Set([
  "cmd+a",
  "cmd+c",
  "cmd+v",
  "cmd+x",
  "cmd+z",
  "cmd+shift+z",
  "cmd+shift+v",
  "cmd+opt+shift+v",
  "cmd+,",
  "cmd+`",
  "cmd+shift+`",
  "cmd+space",
  "cmd+ctrl+space",
  "cmd+opt+space",
  "cmd+ctrl+f",
  "cmd+ctrl+q",
  "cmd+q",
  "cmd+w",
  "cmd+t",
  "cmd+n",
  "cmd+h",
  "cmd+m",
]);
const MODIFIER_ORDER = ["cmd", "ctrl", "opt", "shift"];

export function normalizeShortcut(value: string): string | null {
  if (value.length > 40) return null;
  const words = value.toLowerCase().split("+").map((w) => w.trim());
  const key = words.pop();
  if (!key || !SHORTCUT_KEY.test(key)) return null;
  const modifiers = new Set<string>();
  for (const word of words) {
    const modifier = MODIFIERS[word];
    if (!modifier || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }
  const bare = /^f(?:[1-9]|1[0-2])$/.test(key);
  if (!bare && !modifiers.has("cmd") && !modifiers.has("ctrl") && !modifiers.has("opt")) return null;
  const normalized = [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), key].join("+");
  return RESERVED_SHORTCUTS.has(normalized) ? null : normalized;
}

export function activationEventProblem(value: string): boolean {
  if (value === "*" || value === "onStartupFinished") return true;
  const colon = value.indexOf(":");
  if (colon < 1) return false;
  const rest = value.slice(colon + 1);
  return (ACTIVATION_PREFIXES_V3 as readonly string[]).includes(value.slice(0, colon)) && rest.length > 0 && rest.length <= 253 && !/\s/.test(rest);
}

export const pluginId = str({ pattern: PLUGIN_ID_PATTERN, rule: "a scoped plugin id like @scope/name: lowercase letters, digits and dashes", max: 80 });
export const name = str({ pattern: NAME_PATTERN, rule: "1 to 40 lowercase letters, digits and dashes, starting with a letter or digit" });
export const key = str({ pattern: KEY_PATTERN, rule: "1 to 40 letters, digits, - and _" });
export const symbol = str({ pattern: SYMBOL_PATTERN, rule: "an SF Symbol name", description: "An SF Symbol name" });
export const slug = str({ pattern: SLUG_PATTERN, rule: "a slug of 1 to 32 lowercase letters, digits and dashes" });
export const interfaceName = str({ pattern: INTERFACE_PATTERN, max: 80, rule: "an interface name like ai.provider: dot-separated lowercase words", description: "An interface name like ai.provider" });
export const eventName = str({ pattern: EVENT_PATTERN, max: 80, rule: "an event name like tab.opened" });
export const semver = str({ pattern: SEMVER_PATTERN, test: isSemver, max: 256, rule: "a semver version like 1.2.3" });
export const semverRange = str({ test: isRange, min: 1, max: 256, rule: "a semver range like ^1.2.0 or >=0.3.0 <1.0.0", description: "A semver range; a bare version like 0.3.0 means >=0.3.0" });
export const httpsUrl = str({ pattern: HTTPS_URL_PATTERN, max: LIMITS_V3.url, rule: "an https:// URL", format: "uri" });
export const githubRepo = str({ pattern: GITHUB_REPO_PATTERN, rule: "a GitHub repository like owner/repo" });
export const pluginPath = (rule = "a relative path inside the plugin's folder", suffix?: string): Spec<string> => {
  const ending = suffix ? new RegExp(`${suffix}$`) : null;
  return str({
    pattern: suffix ? `${PLUGIN_PATH_PATTERN.slice(0, -1)}${suffix}$` : PLUGIN_PATH_PATTERN,
    test: (value) => isPluginPath(value) && (!ending || ending.test(value)),
    max: LIMITS_V3.path,
    rule,
  });
};
export const scriptPath = pluginPath("a relative .js, .mjs or .cjs file inside the plugin's folder", "\\.(?:m?js|cjs)");
export const cssPath = pluginPath("a relative .css file inside the plugin's folder", "\\.css");
export const jsonPath = pluginPath("a relative .json file inside the plugin's folder", "\\.json");
export const shortcut = str({
  test: (value) => normalizeShortcut(value) !== null,
  max: 40,
  rule: "a shortcut like cmd+shift+k: cmd, ctrl or opt plus one key, not one Ardia or macOS reserves",
  description: "Modifiers and one key joined by +, like cmd+shift+k",
});
export const when = str({ min: 1, max: LIMITS_V3.when, rule: `a condition of 1 to ${LIMITS_V3.when} characters`, description: 'Shows only when this holds, like urlHost == "github.com" && !isPinned' });
export const argument = str({ pattern: "^[^\\u0000]{1,1024}$", rule: "an argument of 1 to 1024 characters with no NUL" });
export const title = text(LIMITS_V3.title);
export const pageTitle = text(LIMITS_V3.pageTitle);
export const description = text(LIMITS_V3.description);
export const activationEvent = str({
  test: activationEventProblem,
  max: 300,
  rule: `*, onStartupFinished or one of ${ACTIVATION_PREFIXES_V3.map((p) => `${p}:`).join(", ")} followed by a name`,
});

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const TOP_LABEL = "[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = `(?:${LABEL}\\.)+${TOP_LABEL}`;
export const PORT_PATTERN = "(?:[1-9]\\d{0,3}|[1-5]\\d{4}|6[0-4]\\d{3}|65[0-4]\\d{2}|655[0-2]\\d|6553[0-5])";
const LOOPBACK = "(?:localhost|127\\.0\\.0\\.1)";

export const MATCH_PATTERN = `^(?:https://(?:\\*|(?:\\*\\.)?${DOMAIN})|http://${LOOPBACK}:(?:\\*|${PORT_PATTERN}))/[^\\s]*$`;
export const matchPattern = str({
  pattern: MATCH_PATTERN,
  max: 512,
  rule: "a URL match pattern like https://example.com/path* or http://localhost:*/*, with a domain name (no IP addresses) and a port from 1 to 65535",
});

export const NETWORK_HOST_PATTERN = `^(?:(?:\\*\\.)?${DOMAIN}|${LOOPBACK}:${PORT_PATTERN})$`;
export const networkHost = str({
  pattern: NETWORK_HOST_PATTERN,
  max: 253,
  rule: "a host like api.example.com or *.example.com (no IP addresses), or localhost:<port> or 127.0.0.1:<port> with a port from 1 to 65535",
});

