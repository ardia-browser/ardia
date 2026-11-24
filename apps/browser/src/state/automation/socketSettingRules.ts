import { resolveInput } from "@ardia/core";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { siteOf } from "../engines/engines";
import { sameValue } from "../config/configSettings";
import { customNewTabUrl, DEFAULT_SETTINGS, searchEngines, validSettingValue, type SettingKey, type Settings } from "../settings/settings";

type Checked = { patch: Partial<Settings> } | { problem: string };
type Rule = (value: unknown, settings: Settings, requested: Record<string, unknown>) => Checked;

const SCHEME = /^[a-z][\w+.-]*:\/\//i;
const NO_WEBKIT = "WebKit isn't part of Ardia on this platform, so pages always open in Chromium";

const shaped = (key: SettingKey, value: unknown, then: () => Checked): Checked => (validSettingValue(key, value) ? then() : { problem: `${key} isn't a value Settings can choose` });

const needsWebKit = (key: SettingKey, value: unknown, then: () => Checked): Checked =>
  shaped(key, value, () => (PLATFORM_FEATURES.webKit || sameValue(value, DEFAULT_SETTINGS[key]) ? then() : { problem: `${key}: ${NO_WEBKIT}` }));

const typedSite = (typed: string) => siteOf(SCHEME.test(typed.trim()) ? typed.trim() : resolveInput(typed.trim(), ""));

function websiteEngines(value: unknown): Checked {
  const rules: Settings["websiteEngines"] = {};
  for (const [typed, engine] of Object.entries(value as Settings["websiteEngines"])) {
    const site = typedSite(typed);
    if (!site) return { problem: `websiteEngines: ${typed} isn't a website address, like netflix.com` };
    rules[site] = engine;
  }
  return { patch: { websiteEngines: rules } };
}

function newTabUrl(value: unknown): Checked {
  const url = (value as string).trim();
  if (url && !customNewTabUrl({ newTabOpens: "page", minimalismMode: false, newTabUrl: url })) return { problem: "newTabUrl: a New Tab page is an http or https address, about:blank or an Ardia page" };
  return { patch: { newTabUrl: url } };
}

function customSearchUrl(value: unknown, settings: Settings, requested: Record<string, unknown>): Checked {
  const url = (value as string).trim();
  if (!url) {
    if (requested.searchEngine === "custom") return { problem: "customSearchUrl: the Custom engine can't be the default without its URL" };
    const fallBack = settings.searchEngine === "custom" && !Object.hasOwn(requested, "searchEngine");
    return { patch: { customSearchUrl: "", ...(fallBack ? { searchEngine: DEFAULT_SETTINGS.searchEngine } : {}) } };
  }
  if (!/^https?:\/\/[^/?#\s]+/i.test(url)) return { problem: "customSearchUrl: enter a URL that starts with http:// or https://" };
  if (!url.includes("%s")) return { problem: "customSearchUrl: the URL must contain %s where the search terms go" };
  if (searchEngines(settings).some((e) => e.id !== "custom" && e.keyword.toLowerCase() === "custom")) return { problem: "customSearchUrl: “custom” is already used by another search engine" };
  return { patch: { customSearchUrl: url } };
}

const SOCKET_SETTING_RULES: Partial<Record<SettingKey, Rule>> = {
  pageEngine: (value) => shaped("pageEngine", value, () => (value === "webkit" && !PLATFORM_FEATURES.webKit ? { problem: `pageEngine: ${NO_WEBKIT}` } : { patch: { pageEngine: value as Settings["pageEngine"] } })),
  websiteEngines: (value) => needsWebKit("websiteEngines", value, () => websiteEngines(value)),
  protectedVideoInWebKit: (value) => needsWebKit("protectedVideoInWebKit", value, () => ({ patch: { protectedVideoInWebKit: value as boolean } })),
  newTabUrl: (value) => shaped("newTabUrl", value, () => newTabUrl(value)),
  customSearchUrl: (value, settings, requested) => shaped("customSearchUrl", value, () => customSearchUrl(value, settings, requested)),
};

export const hasSocketRule = (key: string): key is SettingKey => Object.hasOwn(SOCKET_SETTING_RULES, key);

export function checkedByRules(values: Record<string, unknown>, settings: Settings, requested: Record<string, unknown> = values) {
  const problems: string[] = [];
  let patch: Partial<Settings> = {};
  for (const [key, value] of Object.entries(values)) {
    const checked = SOCKET_SETTING_RULES[key as SettingKey]!(value, settings, requested);
    if ("problem" in checked) problems.push(checked.problem);
    else patch = { ...patch, ...checked.patch };
  }
  return { patch, problems };
}

export function searchProblem(before: Settings, after: Settings): string | null {
  if (before.searchEngine === after.searchEngine && before.customSearchUrl === after.customSearchUrl) return null;
  return searchEngines(after).some((e) => e.id === after.searchEngine) ? null : `searchEngine ${after.searchEngine} wouldn't exist after this change`;
}
