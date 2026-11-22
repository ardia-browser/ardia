export type ClearRange = "lastHour" | "today" | "todayAndYesterday" | "allTime";
import { copy, type DefaultBrowserSteps } from "../../lib/platformCopy.ts";

export const CLEAR_RANGES: { id: ClearRange; title: string; phrase: string }[] = [
  { id: "lastHour", title: "Last Hour", phrase: "from the last hour" },
  { id: "today", title: "Today", phrase: "from today" },
  { id: "todayAndYesterday", title: "Today and Yesterday", phrase: "from today and yesterday" },
  { id: "allTime", title: "All Time", phrase: "from all time" },
];

export function clearSince(range: ClearRange, now: number): number | null {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  switch (range) {
    case "lastHour":
      return now - 3_600_000;
    case "today":
      return start.getTime();
    case "todayAndYesterday":
      start.setDate(start.getDate() - 1);
      return start.getTime();
    case "allTime":
      return null;
  }
}

export type ClearChoice = { history: boolean; cache: boolean; cookies: boolean; archive: boolean };

export const clearChoice = (history: boolean, cache: boolean, cookies: boolean, archive: boolean, range: ClearRange): ClearChoice => ({
  history,
  cache,
  cookies,
  archive: archive && range === "allTime",
});

export const clearIsEmpty = (choice: ClearChoice) => !choice.history && !choice.cache && !choice.cookies && !choice.archive;

export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function clearNames(choice: ClearChoice): string[] {
  const names: string[] = [];
  if (choice.history) names.push("History");
  if (choice.cache) names.push("Cache");
  if (choice.cookies) names.push("Cookies");
  if (choice.archive) names.push("Archived Tabs");
  return names;
}

function websiteDataNames(choice: ClearChoice): string[] {
  const names: string[] = [];
  if (choice.cache) names.push("Cache");
  if (choice.cookies) names.push("Cookies");
  return names;
}

const websiteDataIgnoresRange = (choice: ClearChoice, range: ClearRange, byTime: boolean) => !byTime && range !== "allTime" && (choice.cache || choice.cookies);

export function clearTitle(choice: ClearChoice, range: ClearRange, websiteDataByTime = true): string {
  const phrase = CLEAR_RANGES.find((r) => r.id === range)!.phrase;
  if (!websiteDataIgnoresRange(choice, range, websiteDataByTime)) return `Clear ${joinList(clearNames(choice))} ${phrase}?`;
  const allTime = `${joinList(websiteDataNames(choice))} from all time`;
  return choice.history ? `Clear History ${phrase}, and ${allTime}?` : `Clear ${allTime}?`;
}

export const clearMessage = (choice: ClearChoice) =>
  choice.cookies ? "You’ll be signed out of websites. Open tabs stay open." : "Open tabs stay open, and you stay signed in to websites.";

export function clearFooter(choice: ClearChoice, range: ClearRange = "allTime", websiteDataByTime = true): string {
  if (clearIsEmpty(choice)) return "Choose what to clear.";
  const lines: string[] = [];
  if (choice.history) lines.push(copy().historyClears);
  lines.push(choice.cookies ? "Clearing cookies signs you out of websites." : "You’ll stay signed in to websites.");
  if (websiteDataIgnoresRange(choice, range, websiteDataByTime)) {
    const names = [choice.cache ? "the cache" : null, choice.cookies ? "cookies and site data" : null].filter((name): name is string => name !== null);
    lines.push(`This phone can only clear ${joinList(names)} entirely, so ${names.length > 1 ? "they clear" : "it clears"} from all time.`);
  }
  return lines.join(" ");
}

export function websiteDataKinds(choice: ClearChoice): ("cache" | "cookiesAndSiteData")[] {
  const kinds: ("cache" | "cookiesAndSiteData")[] = [];
  if (choice.cache) kinds.push("cache");
  if (choice.cookies) kinds.push("cookiesAndSiteData");
  return kinds;
}

export const formatNumber = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const plural = (count: number, one: string, other: string) => `${formatNumber(count)} ${count === 1 ? one : other}`;

export const rulesText = (count: number) => plural(count, "rule", "rules");
export const listsText = (count: number) => plural(count, "list", "lists");

export function relativeTime(date: number, now: number): string {
  const minutes = Math.max(1, Math.round((now - date) / 60_000));
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function updatedText(date: number | null, now: number): string {
  if (date === null) return "Not updated yet";
  if (now - date < 60_000) return "Updated just now";
  return `Updated ${relativeTime(date, now)}`;
}

export function listsStatus(isUpdating: boolean, isOffline: boolean, lastUpdated: number | null, now: number): string {
  if (isUpdating) return "Updating…";
  if (isOffline) return `Offline · ${updatedText(lastUpdated, now)}`;
  return updatedText(lastUpdated, now);
}

export type ListLike = {
  state: "ready" | "downloading" | "compiling" | "failed" | "offline" | "tooLarge";
  isEnabled: boolean;
  updatedAt: number | null;
  ruleCount: number;
};

export function listFacts(list: ListLike, now: number): { text: string; isWarning: boolean } {
  switch (list.state) {
    case "downloading":
      return { text: "Downloading…", isWarning: false };
    case "compiling":
      return { text: "Compiling…", isWarning: false };
    case "failed":
      return { text: "Couldn’t update", isWarning: true };
    case "tooLarge":
      return { text: "Too large for Ardia to use", isWarning: true };
    case "offline":
      return { text: `${rulesText(list.ruleCount)} · Waiting for a connection`, isWarning: false };
    case "ready":
      if (!list.isEnabled && list.updatedAt === null) return { text: "Downloads when you turn it on", isWarning: false };
      return { text: `${rulesText(list.ruleCount)} · ${updatedText(list.updatedAt, now)}`, isWarning: false };
  }
}

export function listStatus(list: ListLike): string {
  switch (list.state) {
    case "downloading":
      return "Downloading…";
    case "compiling":
      return "Compiling…";
    case "failed":
      return "Couldn’t Update";
    case "tooLarge":
      return "Too Large";
    case "offline":
      return "Offline";
    case "ready":
      return list.isEnabled ? "On" : "Off";
  }
}

export const listIsBusy = (list: ListLike) => list.state === "downloading" || list.state === "compiling";

export function resetMessage(customLists: number): string {
  if (customLists <= 0) return "uBlock Origin’s default lists turn back on and the rest turn off.";
  const removed = `${formatNumber(customLists)} ${customLists === 1 ? "list" : "lists"} you added`;
  return `uBlock Origin’s default lists turn back on, the rest turn off, and ${removed} will be removed.`;
}

export const myFiltersCount = (ruleCount: number) => (ruleCount === 0 ? "None" : rulesText(ruleCount));

export function myFiltersSummary(ruleCount: number, skippedCount: number, hasChanges: boolean): string {
  if (hasChanges) return "Changes aren’t applied yet";
  if (ruleCount === 0 && skippedCount === 0) return "No rules yet";
  const rules = rulesText(ruleCount);
  return skippedCount > 0 ? `${rules} · ${formatNumber(skippedCount)} skipped` : rules;
}

export const FILTER_LIST_ADDRESS = {
  empty: "Enter the list’s address.",
  invalid: "Enter an address that starts with https://.",
  footer: "Adblock Plus or uBlock Origin format.",
  failed: "Couldn’t add that list.",
} as const;

export function filterListAddress(text: string): { url: string } | { message: string } {
  const trimmed = text.trim();
  if (!trimmed) return { message: FILTER_LIST_ADDRESS.empty };
  const match = /^(https?):\/\/([^\s/?#:@]+)(?::\d+)?(?:[/?#]\S*)?$/i.exec(trimmed);
  if (!match || !match[2]!.includes(".")) return { message: FILTER_LIST_ADDRESS.invalid };
  return { url: trimmed };
}

export type OnboardingStep = "welcome" | "blocking" | "defaultBrowser" | "sync" | "allSet";

export const ONBOARDING_STEPS: readonly OnboardingStep[] = ["welcome", "blocking", "defaultBrowser", "sync", "allSet"];

export const restoredOnboardingStep = (raw: string | null, offersSync = true): OnboardingStep => {
  const step = (ONBOARDING_STEPS as readonly string[]).includes(raw ?? "") ? (raw as OnboardingStep) : "welcome";
  return step === "sync" && !offersSync ? "allSet" : step;
};

const shownSteps = (offersDefaultBrowser: boolean, offersSync = true) => ONBOARDING_STEPS.filter((step) => (step !== "defaultBrowser" || offersDefaultBrowser) && (step !== "sync" || offersSync));

export const nextStep = (step: OnboardingStep, offersDefaultBrowser = false, offersSync = true): OnboardingStep | null => {
  const steps = shownSteps(offersDefaultBrowser, offersSync);
  const at = steps.indexOf(step);
  return at < 0 ? (shownSteps(true).slice(shownSteps(true).indexOf(step) + 1).find((s) => steps.includes(s)) ?? null) : (steps[at + 1] ?? null);
};

export const previousStep = (step: OnboardingStep, offersDefaultBrowser = false, offersSync = true): OnboardingStep | null => {
  const steps = shownSteps(offersDefaultBrowser, offersSync);
  const at = steps.indexOf(step);
  return at <= 0 ? null : (steps[at - 1] ?? null);
};

export type DefaultBrowserAction = "askForRole" | "openDefaultApps";

export type DefaultBrowserCopy = { title: string; subtitle: string; steps: string[]; action: string | null; does: DefaultBrowserAction | null; inSettings: boolean };

export const DEFAULT_BROWSER_ACTION = "Set as Default Browser";
export const OPEN_DEFAULT_APPS = "Open Default Apps";

type Status = { isDefault: boolean; canAsk: boolean };

export function offersDefaultBrowser(status: Status | null, always = copy().offersDefaultBrowserAlways): boolean {
  if (!status) return always;
  return always || status.canAsk || status.isDefault;
}

export function defaultBrowserCopy(status: Status, instructions: DefaultBrowserSteps | null = copy().defaultBrowserInstructions): DefaultBrowserCopy {
  if (instructions) {
    return { title: instructions.title, subtitle: instructions.subtitle, steps: instructions.steps, action: instructions.action, does: "openDefaultApps", inSettings: true };
  }
  if (status.isDefault) return { title: "Ardia is your default browser", subtitle: "Links from other apps open in Ardia.", steps: [], action: null, does: null, inSettings: false };
  const action = status.canAsk ? DEFAULT_BROWSER_ACTION : OPEN_DEFAULT_APPS;
  return {
    title: "Make Ardia your default browser",
    subtitle: "Open links from other apps in Ardia.",
    steps: [`Tap “${action}”`, status.canAsk ? "Select Ardia" : "Choose Browser app"],
    action,
    does: status.canAsk ? "askForRole" : "openDefaultApps",
    inSettings: false,
  };
}

export const exportableUrls = (tabs: readonly { url: string; isPrivate: boolean }[]) =>
  tabs.filter((tab) => !tab.isPrivate && /^https?:\/\//i.test(tab.url)).map((tab) => tab.url);

export type PageSwipe = "anywhere" | "edges" | "off";

export const pageSwipe = (mode: "anywhere" | "screenEdges" | "disabled"): PageSwipe => (mode === "screenEdges" ? "edges" : mode === "disabled" ? "off" : "anywhere");

export type FrontSheet = "settings" | "library" | "archive" | "spaces";

export const frontSheet = (settingsOpen: boolean, browseSheet: "archive" | "spaces" | null, libraryOpen = false): FrontSheet | null => (settingsOpen ? "settings" : libraryOpen ? "library" : browseSheet);

export const listsUpdateFailed = (state: { isOffline: boolean; lists: readonly { isEnabled: boolean; state: string }[] }): boolean =>
  state.isOffline || state.lists.some((list) => list.isEnabled && list.state === "failed");

export const listUpdatedAt = (at: number, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));

export const FALLBACK_ENGINES: readonly { id: string; name: string }[] = [
  { id: "google", name: "Google" },
  { id: "bing", name: "Bing" },
  { id: "duckduckgo", name: "DuckDuckGo" },
  { id: "ecosia", name: "Ecosia" },
  { id: "brave", name: "Brave Search" },
  { id: "kagi", name: "Kagi" },
  { id: "startpage", name: "Startpage" },
  { id: "yahoo", name: "Yahoo" },
];

export function pickerEngines(loaded: readonly { id: string; name: string; custom: boolean }[]): { id: string; name: string }[] {
  const builtIn = loaded.filter((engine) => !engine.custom).map(({ id, name }) => ({ id, name }));
  return builtIn.length ? builtIn : [...FALLBACK_ENGINES];
}
