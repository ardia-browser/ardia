import { ENGINE_KEPT_CODES } from "./engineKeptCodes";

export type MemoryPressure = "normal" | "warning" | "critical";
type SleepMode = "moderate" | "balanced" | "maximum";

export type SleepRules = { tabs: number; hiddenMs: number; pressure: MemoryPressure; perTick: number; everyMs: number };

export type SleepVeto =
  | "notSleepable"
  | "shown"
  | "cliSession"
  | "call"
  | "pictureInPicture"
  | "audible"
  | "recentlyAudible"
  | "frequentlyUsed"
  | "recentlySeen"
  | "keptRecently"
  | "loading"
  | "typedInput"
  | "postedDocument"
  | "beforeUnload"
  | "download"
  | "other";

export type TabSleepFacts = {
  id: string;
  sleepable: boolean;
  shown: boolean;
  cliSession: boolean;
  lastSeenAt: number;
  switches: number;
  audible: boolean;
  lastAudibleAt: number;
  call: boolean;
  pictureInPicture: boolean;
  loading: boolean;
  askAgainAt: number;
};

export const MINUTE = 60_000;
export const RECENTLY_SEEN_MS = 10 * MINUTE;
export const RECENTLY_AUDIBLE_MS = MINUTE;
export const FREQUENT_SWITCHES = 15;
const SLEEPS_PER_TICK = 4;

const GIB = 2 ** 30;
const MODES: Record<SleepMode, { floor: number; perGib: number; hiddenMs: number }> = {
  moderate: { floor: 20, perGib: 2, hiddenMs: 120 * MINUTE },
  balanced: { floor: 10, perGib: 1, hiddenMs: 60 * MINUTE },
  maximum: { floor: 5, perGib: 0.5, hiddenMs: 30 * MINUTE },
};
const UNDER_PRESSURE: Record<Exclude<MemoryPressure, "normal">, { hiddenMs: number; everyMs: number }> = {
  warning: { hiddenMs: 5 * MINUTE, everyMs: 15_000 },
  critical: { hiddenMs: 2 * MINUTE, everyMs: 10_000 },
};
const WARM_VIEWS: Record<MemoryPressure, number> = { normal: Infinity, warning: 2, critical: 0 };

export const pressureOf = (level: unknown): MemoryPressure => (level === "warning" || level === "critical" ? level : "normal");

export function sleepRules(settings: { memorySaver: boolean; memorySaverMode: string }, sys: { memoryPressure: string; physicalMemory: number } | null): SleepRules | null {
  if (settings.memorySaver === false || !sys) return null;
  const mode = MODES[settings.memorySaverMode as SleepMode] ?? MODES.balanced;
  const pressure = pressureOf(sys.memoryPressure);
  if (pressure !== "normal") return { tabs: mode.floor, hiddenMs: Math.min(mode.hiddenMs, UNDER_PRESSURE[pressure].hiddenMs), pressure, perTick: SLEEPS_PER_TICK, everyMs: UNDER_PRESSURE[pressure].everyMs };
  return { tabs: Math.max(mode.floor, Math.round((sys.physicalMemory / GIB) * mode.perGib)), hiddenMs: mode.hiddenMs, pressure, perTick: SLEEPS_PER_TICK, everyMs: MINUTE };
}

const warmViewCap = (pressure: MemoryPressure) => WARM_VIEWS[pressure];

export function warmOrder(neighbours: readonly string[], successor: string | undefined): string[] {
  return successor && !neighbours.includes(successor) ? [successor, ...neighbours] : [...neighbours];
}

export function capWarmPanes(order: readonly string[], panesOf: (id: string) => readonly string[], shown: ReadonlySet<string>, pressure: MemoryPressure): string[] {
  const panes: string[] = [];
  for (const id of order) {
    const own = panesOf(id);
    for (const pane of own.includes(id) ? [id, ...own.filter((p) => p !== id)] : own) if (!shown.has(pane) && !panes.includes(pane)) panes.push(pane);
  }
  const cap = warmViewCap(pressure);
  return panes.length > cap ? panes.slice(0, cap) : panes;
}

const seenWindowMs = (rules: Pick<SleepRules, "hiddenMs" | "pressure">) => (rules.pressure === "normal" ? Math.max(rules.hiddenMs, RECENTLY_SEEN_MS) : rules.hiddenMs);

export function sleepVeto(tab: TabSleepFacts, now: number, rules: Pick<SleepRules, "hiddenMs" | "pressure">): SleepVeto | null {
  if (!tab.sleepable) return "notSleepable";
  if (tab.shown) return "shown";
  if (tab.cliSession) return "cliSession";
  if (tab.call) return "call";
  if (tab.pictureInPicture) return "pictureInPicture";
  if (tab.audible) return "audible";
  if (now - tab.lastAudibleAt < RECENTLY_AUDIBLE_MS) return "recentlyAudible";
  if (tab.switches >= FREQUENT_SWITCHES) return "frequentlyUsed";
  if (now - tab.lastSeenAt < seenWindowMs(rules)) return "recentlySeen";
  if (tab.askAgainAt > now) return "keptRecently";
  if (tab.loading) return "loading";
  return null;
}

export type SleepPlan = { sleep: string[]; vetoed: { id: string; veto: SleepVeto }[] };

export function tabsToSleep(awake: readonly TabSleepFacts[], now: number, rules: Pick<SleepRules, "tabs" | "hiddenMs" | "pressure">): SleepPlan {
  if (awake.length <= rules.tabs) return { sleep: [], vetoed: [] };
  const recency = (t: TabSleepFacts) => (t.shown ? now : t.lastSeenAt);
  const over = [...awake].sort((a, b) => recency(b) - recency(a)).slice(rules.tabs).reverse();
  const plan: SleepPlan = { sleep: [], vetoed: [] };
  for (const tab of over) {
    const veto = sleepVeto(tab, now, rules);
    if (veto) plan.vetoed.push({ id: tab.id, veto });
    else plan.sleep.push(tab.id);
  }
  return plan;
}

const ENGINE_VETOES: Readonly<Record<number, SleepVeto>> = {
  [-1]: "notSleepable",
  4: "shown",
  5: "audible",
  6: "recentlyAudible",
  7: "recentlySeen",
  8: "pictureInPicture",
  15: "call",
  16: "call",
  17: "call",
  18: "call",
  19: "call",
  22: "shown",
  26: "typedInput",
  27: "typedInput",
  ...Object.fromEntries(ENGINE_KEPT_CODES.map((kept) => [kept.code, kept.veto])),
};

const ENGINE_ORDER: readonly SleepVeto[] = ["postedDocument", "beforeUnload", "typedInput", "download", "cliSession", "call", "pictureInPicture", "audible", "recentlyAudible", "recentlySeen", "shown", "notSleepable"];

export function engineVeto(keptBy: readonly number[]): SleepVeto | null {
  if (!keptBy.length) return null;
  const vetoes = new Set(keptBy.map((code) => ENGINE_VETOES[code] ?? "other"));
  return ENGINE_ORDER.find((veto) => vetoes.has(veto)) ?? "other";
}
