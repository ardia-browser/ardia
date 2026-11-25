import { getAppLocale, getUiLocale, isZhHans, resolveAppLocale, setAppLocaleOverride, UI_LOCALE, type AppLocale } from "./locale";
import { zhHansCore } from "./zhHansCore";
import { zhHansSettingsA } from "./zhHansSettingsA";
import { zhHansSettingsB } from "./zhHansSettingsB";
import { zhHansSettingsC } from "./zhHansSettingsC";

export { getAppLocale, getUiLocale, isZhHans, resolveAppLocale, setAppLocaleOverride, UI_LOCALE, type AppLocale };

export type MessageVars = Record<string, string | number>;

const zhHansCatalog: Record<string, string> = {
  ...zhHansCore,
  ...zhHansSettingsA,
  ...zhHansSettingsB,
  ...zhHansSettingsC,
};

const interpolate = (template: string, vars?: MessageVars): string => {
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : String(value);
  });
};

export const t = (text: string, vars?: MessageVars): string => {
  const template = getAppLocale() === "zh-Hans" ? (zhHansCatalog[text] ?? text) : text;
  return interpolate(template, vars);
};

export const tp = (singular: string, plural: string, count: number, vars?: MessageVars): string => {
  const key = count === 1 ? singular : plural;
  return t(key, { count, ...vars });
};
