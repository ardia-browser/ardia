import { t } from "./uiLanguage";
export type LaunchValue = string | number | boolean | null | undefined;

export type LaunchArguments = {
  isDemo: boolean;
  browseOpen: string | null;
  browseQuery: string | null;
  browseSurface: string | null;
  browseTab: number | null;
  browseToolbar: boolean;
  browseReader: boolean;
  browseIncognito: boolean;
  browseDelayMs: number;
  browseDeck: boolean;
  browseDeckOpen: number | null;
  browseDeckPull: number | null;
  browsePlus: boolean;
  browseOverlay: string | null;
  browseResearch: string | null;
  voiceHeard: string | null;
  browseSteps: number[];
  browseStepGapMs: number;
  deckScript: string | null;
  showsOnboarding: boolean;
  openSheet: string | null;
  opensSettings: boolean;
  settingsPage: string | null;
  restingStart: boolean;
  color: string | null;
  interfaceStyle: string | null;
  colorScheme: string | null;
  toast: string | null;
  trustedSitesSample: boolean;
  pagerFreeze: number | null;
  pagerScript: boolean;
  loadFreeze: number | null;
  demoScale: number;
  openingCard: boolean;
  oneContainerScroll: boolean;
  redesign: boolean;
};

export const LAUNCH_TIMING = { delaySeconds: 6, stepGapSeconds: 1.5, deckOpenMs: 3000, sheetMs: 600, toastMs: 1500, deckScriptStartMs: 1200, snapWaitMs: 5000 } as const;

const FALSE_WORDS = new Set(["false", "no", "0"]);

function text(values: Record<string, LaunchValue>, key: string): string | null {
  const value = values[key];
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function raw(values: Record<string, LaunchValue>, key: string): string | null {
  const value = values[key];
  return value === null || value === undefined ? null : String(value);
}

function flag(values: Record<string, LaunchValue>, key: string): boolean {
  const value = values[key];
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Math.trunc(value) !== 0;
  return !FALSE_WORDS.has(String(value).trim().toLowerCase());
}

function number(values: Record<string, LaunchValue>, key: string): number | null {
  const value = text(values, key);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const whole = (values: Record<string, LaunchValue>, key: string): number | null => {
  const value = number(values, key);
  return value === null ? null : Math.trunc(value);
};

export function parseLaunchArguments(values: Record<string, LaunchValue>): LaunchArguments {
  const isDemo = flag(values, t(`ArdiaDemo`));
  return {
    isDemo,
    browseOpen: text(values, t(`BrowseOpen`)),
    browseQuery: raw(values, t(`BrowseQuery`)),
    browseSurface: text(values, t(`BrowseSurface`)),
    browseTab: whole(values, t(`BrowseTab`)),
    browseToolbar: flag(values, t(`BrowseToolbar`)),
    browseReader: flag(values, t(`BrowseReader`)),
    browseIncognito: flag(values, t(`BrowseIncognito`)),
    browseDelayMs: (number(values, t(`BrowseDelay`)) ?? LAUNCH_TIMING.delaySeconds) * 1000,
    browseDeck: flag(values, t(`BrowseDeck`)),
    browseDeckOpen: whole(values, t(`BrowseDeckOpen`)),
    browseDeckPull: whole(values, t(`BrowseDeckPull`)),
    browsePlus: flag(values, t(`BrowsePlus`)),
    browseOverlay: raw(values, t(`BrowseOverlay`)),
    browseResearch: text(values, t(`BrowseResearch`)),
    voiceHeard: text(values, t(`ArdiaVoiceHeard`)),
    browseSteps: (text(values, t(`BrowseSteps`)) ?? "")
      .split(",")
      .map((step) => step.trim())
      .filter((step) => /^-?\d+$/.test(step))
      .map(Number),
    browseStepGapMs: (number(values, t(`BrowseStepGap`)) ?? LAUNCH_TIMING.stepGapSeconds) * 1000,
    deckScript: text(values, t(`ArdiaDeck`)),
    showsOnboarding: flag(values, t(`ArdiaOnboarding`)),
    openSheet: text(values, t(`ArdiaOpenSheet`)),
    opensSettings: flag(values, t(`ArdiaOpenSettings`)),
    settingsPage: text(values, t(`ArdiaSettingsPage`)),
    restingStart: flag(values, t(`ArdiaRestingStart`)),
    color: text(values, t(`ArdiaColor`)),
    interfaceStyle: text(values, t(`ArdiaInterfaceStyle`)),
    colorScheme: text(values, t(`ArdiaColorScheme`)),
    toast: text(values, t(`ArdiaToast`)),
    trustedSitesSample: flag(values, t(`ArdiaTrustedSites`)),
    pagerFreeze: isDemo ? number(values, t(`BrowsePagerFreeze`)) : null,
    pagerScript: isDemo && flag(values, t(`BrowsePagerScript`)),
    loadFreeze: isDemo ? number(values, t(`BrowseLoadFreeze`)) : null,
    demoScale: isDemo ? Math.max(0, whole(values, t(`ArdiaDemoScale`)) ?? 0) : 0,
    openingCard: flag(values, t(`ArdiaOpeningCard`)),
    oneContainerScroll: flag(values, t(`ArdiaOneContainerScroll`)),
    redesign: flag(values, t(`ArdiaRedesign`)),
  };
}

export const NO_LAUNCH_ARGUMENTS = parseLaunchArguments({});

export type DeckStep = { kind: string; argument: string | null };

export const deckSteps = (script: string): DeckStep[] =>
  script
    .split(",")
    .map((step) => step.trim())
    .filter(Boolean)
    .map((step) => {
      const [kind, argument] = step.split(":");
      return { kind: kind!, argument: argument ?? null };
    });

export const TRUSTED_SITES_SAMPLE = ["nytimes.com", "theverge.com", "bbc.co.uk"] as const;
