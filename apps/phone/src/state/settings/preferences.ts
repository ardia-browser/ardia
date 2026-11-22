import { sanitizeTheme, type ProfileTheme } from "@ardia/core/src/theme.ts";
import type { InterfaceStyleChoice, SchemeChoice } from "../../lib/appearance.ts";
import { isAutoArchiveInterval, STANDARD_AUTO_ARCHIVE, type AutoArchiveInterval } from "../tabs/tabModels.ts";

export type NightShadeMode = "disabled" | "automatic" | "always";
export type SwipeNavigationMode = "anywhere" | "screenEdges" | "disabled";
export type AppLinkPreference = "ardia" | "app";
export type PresetColor = "plum" | "blue" | "purple" | "pink" | "red" | "orange" | "yellow" | "green" | "neutral";
export type ColorChoice = PresetColor | "custom";

export type Preferences = {
  autoArchiveInterval: AutoArchiveInterval;
  nightShade: NightShadeMode;
  swipeNavigation: SwipeNavigationMode;
  appLinks: AppLinkPreference;
  searchSuggestions: boolean;
  searchEngineId: string;
  collapsesBottomBar: boolean | null;
  autoOpensKeyboard: boolean;
  hasFinishedOnboarding: boolean;
  archiveCardShown: boolean;
  tabSwipeHintShown: boolean;
  colorChoice: ColorChoice | null;
  customTheme: ProfileTheme | null;
  dynamicColors: boolean | null;
  materialYou: boolean;
  interfaceStyle: InterfaceStyleChoice;
  schemeChoice: SchemeChoice;
  readerStep: number;
  readerSerif: boolean;
  readerTheme: "light" | "sepia" | "dark" | null;
};

export const DEFAULT_PREFERENCES: Preferences = {
  autoArchiveInterval: STANDARD_AUTO_ARCHIVE,
  nightShade: "disabled",
  swipeNavigation: "anywhere",
  appLinks: "ardia",
  searchSuggestions: true,
  searchEngineId: "google",
  collapsesBottomBar: null,
  autoOpensKeyboard: true,
  hasFinishedOnboarding: false,
  archiveCardShown: false,
  tabSwipeHintShown: false,
  colorChoice: null,
  customTheme: null,
  dynamicColors: null,
  materialYou: false,
  interfaceStyle: "matchMac",
  schemeChoice: "matchMac",
  readerStep: 2,
  readerSerif: true,
  readerTheme: null,
};

export const PREFERENCE_KEYS: Record<keyof Preferences, string> = {
  autoArchiveInterval: "tabs.autoArchiveInterval",
  nightShade: "browsing.nightShade",
  swipeNavigation: "browsing.swipeNavigation",
  appLinks: "browsing.appLinks",
  searchSuggestions: "browsing.searchSuggestions",
  searchEngineId: "browsing.searchEngine",
  collapsesBottomBar: "settings.collapseBottomBar",
  autoOpensKeyboard: "settings.autoOpenKeyboard",
  hasFinishedOnboarding: "settings.finishedOnboarding",
  archiveCardShown: "tabs.archiveCardShown",
  tabSwipeHintShown: "tabs.swipeHintShown",
  colorChoice: "settings.color",
  customTheme: "settings.customTheme",
  dynamicColors: "settings.dynamicColors",
  materialYou: "settings.materialYou",
  interfaceStyle: "settings.interfaceStyle",
  schemeChoice: "settings.schemeChoice",
  readerStep: "reader.sizeStep",
  readerSerif: "reader.serif",
  readerTheme: "reader.theme",
};

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (raw: string): T | undefined =>
    (values as readonly string[]).includes(raw) ? (raw as T) : undefined;

function storedTheme(raw: string): ProfileTheme | undefined {
  try {
    return sanitizeTheme(JSON.parse(raw)) ?? undefined;
  } catch {
    return undefined;
  }
}

const flag = (raw: string) => (raw === "true" ? true : raw === "false" ? false : undefined);

const PARSERS: { [K in keyof Preferences]: (raw: string) => Preferences[K] | undefined } = {
  autoArchiveInterval: (raw) => (isAutoArchiveInterval(raw) ? raw : undefined),
  nightShade: oneOf<NightShadeMode>(["disabled", "automatic", "always"]),
  swipeNavigation: oneOf<SwipeNavigationMode>(["anywhere", "screenEdges", "disabled"]),
  appLinks: oneOf<AppLinkPreference>(["ardia", "app"]),
  searchSuggestions: flag,
  searchEngineId: (raw) => raw || undefined,
  collapsesBottomBar: flag,
  autoOpensKeyboard: flag,
  hasFinishedOnboarding: flag,
  archiveCardShown: flag,
  tabSwipeHintShown: flag,
  colorChoice: oneOf<ColorChoice>(["plum", "blue", "purple", "pink", "red", "orange", "yellow", "green", "neutral", "custom"]),
  customTheme: storedTheme,
  dynamicColors: flag,
  materialYou: flag,
  interfaceStyle: oneOf<InterfaceStyleChoice>(["matchMac", "glass", "classic"]),
  schemeChoice: oneOf<SchemeChoice>(["matchMac", "system", "light", "dark"]),
  readerStep: (raw) => (/^\d$/.test(raw) && Number(raw) <= 6 ? Number(raw) : undefined),
  readerSerif: flag,
  readerTheme: oneOf<"light" | "sepia" | "dark">(["light", "sepia", "dark"]),
};

export const acceptsPreference = (name: keyof Preferences, raw: string) => PARSERS[name](raw) !== undefined;

export const defaultPreferences = (platform?: string): Preferences => ({ ...DEFAULT_PREFERENCES, collapsesBottomBar: platform === "android" });

export function parsePreferences(stored: Record<string, string>, platform?: string): Preferences {
  const out = { ...defaultPreferences(platform) } as Record<keyof Preferences, unknown>;
  for (const name of Object.keys(PREFERENCE_KEYS) as (keyof Preferences)[]) {
    const raw = stored[PREFERENCE_KEYS[name]];
    if (raw === undefined) continue;
    const value = PARSERS[name](raw);
    if (value !== undefined) out[name] = value;
  }
  return out as Preferences;
}

export const serializePreference = <K extends keyof Preferences>(value: Preferences[K]): string | null =>
  value === null ? null : typeof value === "object" ? JSON.stringify(value) : String(value);
