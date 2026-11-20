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
  const isDemo = flag(values, "ArdiaDemo");
  return {
    isDemo,
    browseOpen: text(values, "BrowseOpen"),
    browseQuery: raw(values, "BrowseQuery"),
    browseSurface: text(values, "BrowseSurface"),
    browseTab: whole(values, "BrowseTab"),
    browseToolbar: flag(values, "BrowseToolbar"),
    browseReader: flag(values, "BrowseReader"),
    browseIncognito: flag(values, "BrowseIncognito"),
    browseDelayMs: (number(values, "BrowseDelay") ?? LAUNCH_TIMING.delaySeconds) * 1000,
    browseDeck: flag(values, "BrowseDeck"),
    browseDeckOpen: whole(values, "BrowseDeckOpen"),
    browseDeckPull: whole(values, "BrowseDeckPull"),
    browsePlus: flag(values, "BrowsePlus"),
    browseOverlay: raw(values, "BrowseOverlay"),
    browseResearch: text(values, "BrowseResearch"),
    voiceHeard: text(values, "ArdiaVoiceHeard"),
    browseSteps: (text(values, "BrowseSteps") ?? "")
      .split(",")
      .map((step) => step.trim())
      .filter((step) => /^-?\d+$/.test(step))
      .map(Number),
    browseStepGapMs: (number(values, "BrowseStepGap") ?? LAUNCH_TIMING.stepGapSeconds) * 1000,
    deckScript: text(values, "ArdiaDeck"),
    showsOnboarding: flag(values, "ArdiaOnboarding"),
    openSheet: text(values, "ArdiaOpenSheet"),
    opensSettings: flag(values, "ArdiaOpenSettings"),
    settingsPage: text(values, "ArdiaSettingsPage"),
    restingStart: flag(values, "ArdiaRestingStart"),
    color: text(values, "ArdiaColor"),
    interfaceStyle: text(values, "ArdiaInterfaceStyle"),
    colorScheme: text(values, "ArdiaColorScheme"),
    toast: text(values, "ArdiaToast"),
    trustedSitesSample: flag(values, "ArdiaTrustedSites"),
    pagerFreeze: isDemo ? number(values, "BrowsePagerFreeze") : null,
    pagerScript: isDemo && flag(values, "BrowsePagerScript"),
    loadFreeze: isDemo ? number(values, "BrowseLoadFreeze") : null,
    demoScale: isDemo ? Math.max(0, whole(values, "ArdiaDemoScale") ?? 0) : 0,
    openingCard: flag(values, "ArdiaOpeningCard"),
    oneContainerScroll: flag(values, "ArdiaOneContainerScroll"),
    redesign: flag(values, "ArdiaRedesign"),
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
