export type AppLocale = "en" | "zh-Hans";

let overrideLocale: AppLocale | null = null;

const readRawSystemLocale = (): string => {
  const nav = (globalThis as { navigator?: { language?: string; languages?: readonly string[] } }).navigator;
  if (nav?.languages && nav.languages.length > 0 && nav.languages[0]) return nav.languages[0];
  if (nav?.language) return nav.language;
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en-US";
  }
};

export const resolveAppLocale = (raw: string): AppLocale => {
  const normalized = raw.trim().replace(/_/g, "-").toLowerCase();
  if (!normalized.startsWith("zh")) return "en";
  if (normalized.includes("hant") || normalized.includes("-tw") || normalized.includes("-hk") || normalized.includes("-mo")) {
    return "en";
  }
  return "zh-Hans";
};

export const getAppLocale = (): AppLocale => overrideLocale ?? resolveAppLocale(readRawSystemLocale());

export const isZhHans = (): boolean => getAppLocale() === "zh-Hans";

export const setAppLocaleOverride = (locale: AppLocale | null): void => {
  overrideLocale = locale;
};

const systemRegion = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.split("-").slice(1).find((part) => /^([A-Z]{2}|\d{3})$/.test(part));
  } catch {
    return undefined;
  }
})();

export const getUiLocale = (): string => {
  if (getAppLocale() === "zh-Hans") return systemRegion ? `zh-Hans-${systemRegion}` : "zh-Hans-CN";
  return systemRegion ? `en-${systemRegion}` : "en-US";
};

export const UI_LOCALE = getUiLocale();
