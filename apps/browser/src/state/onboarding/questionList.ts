import type { Settings } from "../settings/settings";

export type OnboardingStep = "intro" | "source" | "layout" | "tabs" | "look" | "searchPrivacy" | "pins" | "home" | "outro";

export type QuestionId =
  | "source"
  | "tabs"
  | "address"
  | "cmdl"
  | "newTab"
  | "newTabPosition"
  | "tidy"
  | "quit"
  | "windows"
  | "tabsMore"
  | "color" | "switcher" | "appearance" | "style" | "frame" | "siteColor" | "lookMore"
  | "engine"
  | "typed"
  | "crash"
  | "pins"
  | "default"
  | "links"
  | "outro";

export type Question = { id: QuestionId; keys: readonly (keyof Settings)[]; askedWithPreset?: true };

export const QUESTIONS: Record<Exclude<OnboardingStep, "intro">, Question[]> = {
  source: [{ id: "source", keys: [] }],
  layout: [
    { id: "tabs", keys: ["tabLayout"] },
    { id: "address", keys: ["addressBar"] },
    { id: "cmdl", keys: ["commandBarPlacement"] },
  ],
  tabs: [
    { id: "newTab", keys: ["newTabOpens"] },
    { id: "newTabPosition", keys: ["newTabPosition", "newTabButtonPosition"] },
    { id: "tidy", keys: ["cleanUpInactiveTabsAfterMinutes"] },
    { id: "quit", keys: ["restoreSession"] },
    { id: "windows", keys: ["shareTabsAcrossWindows"] },
    { id: "tabsMore", keys: ["balancedTopApps", "peekModifier", "undoReopensClosedTab", "cmdClickCreatesTabGroup"] },
  ],
  look: [
    { id: "color", keys: [] },
    { id: "switcher", keys: ["profileSwitcherIcons"], askedWithPreset: true },
    { id: "appearance", keys: ["appearance"] },
    { id: "style", keys: ["interfaceStyle", "glassTintWithTheme", "glassTintAmount"], askedWithPreset: true },
    { id: "frame", keys: ["pageFrame", "borderlessMode"], askedWithPreset: true },
    { id: "siteColor", keys: ["extendWebsiteColor"] },
    { id: "lookMore", keys: ["hideToolbarWhileScrolling", "bookmarksBar"] },
  ],
  searchPrivacy: [
    { id: "engine", keys: ["searchEngine"] },
    { id: "typed", keys: ["commandBarPreference"] },
    { id: "crash", keys: [] },
  ],
  pins: [{ id: "pins", keys: [] }],
  home: [
    { id: "default", keys: [] },
    { id: "links", keys: ["openLinksInLittleArdia"] },
  ],
  outro: [{ id: "outro", keys: [] }],
};

export const QUESTION_ORDER: QuestionId[] = Object.values(QUESTIONS).flatMap((list) => list.map((q) => q.id));
