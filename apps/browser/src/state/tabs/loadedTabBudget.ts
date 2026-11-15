import type { SystemState } from "../../platform/performance";
import { everySlowly } from "../../platform/slowTimers";
import { webviews } from "../../platform/webviews";
import { withDeadline } from "../../lib/deadline";
import { useBrowser, type BrowserState } from "../browser/store";
import { tabEngine } from "../engines/engines";
import { isPlaying, useMedia } from "../media/media";
import { withSharedFamily } from "../pins/pinShare";
import type { Settings } from "../settings/settings";
import { withPinnedPanes } from "../splits/splits";
import { noteTabSleptOverBudget, noteTabSleptOverBudgetReopened } from "../telemetry/tabSleepCounts";
import { hasPage } from "./pageSession";
import { usePages } from "./pageState";
import { shownTabIds } from "./shownTabs";
import { isSleeping } from "./sleepingTabs";

export type LoadedTabBudget = { tabs: number; hiddenMs: number };

const MINUTE = 60_000;
const GIB = 2 ** 30;
const SWEEP_MS = MINUTE;
const MODES: Record<Settings["memorySaverMode"], { floor: number; perGib: number; hiddenMs: number }> = {
  moderate: { floor: 20, perGib: 2, hiddenMs: 120 * MINUTE },
  balanced: { floor: 10, perGib: 1, hiddenMs: 60 * MINUTE },
  maximum: { floor: 5, perGib: 0.5, hiddenMs: 30 * MINUTE },
};
const HIDDEN_UNDER_PRESSURE_MS = 10 * MINUTE;
const SLEEPS_PER_SWEEP = 4;
const ANSWER_WITHIN_MS = 1500;
const ASK_AGAIN_MS = 10 * MINUTE;
const REOPENED_SOON_MS = 30 * MINUTE;
const RECENTLY_VISIBLE = 7;

export function loadedTabBudget(settings: Pick<Settings, "memorySaver" | "memorySaverMode">, sys: SystemState | null): LoadedTabBudget | null {
  if (settings.memorySaver === false || !sys) return null;
  const mode = MODES[settings.memorySaverMode] ?? MODES.balanced;
  if (sys.memoryPressure !== "normal") return { tabs: mode.floor, hiddenMs: Math.min(mode.hiddenMs, HIDDEN_UNDER_PRESSURE_MS) };
  return { tabs: Math.max(mode.floor, Math.round((sys.physicalMemory / GIB) * mode.perGib)), hiddenMs: mode.hiddenMs };
}

function inUse(s: BrowserState, id: string): boolean {
  const media = useMedia.getState();
  const access = usePages.getState().pages[id]?.mediaAccess;
  return (
    !!s.live[id]?.playingAudio ||
    !!media.pipOpen[id] ||
    isPlaying(media.sessions[id]) ||
    !!(access && (access.camera || access.microphone || access.screen)) ||
    !!media.tabShares[id] ||
    Object.values(media.tabShares).some((share) => share.capturedTabId === id)
  );
}

const awakeOf = (s: BrowserState, loaded: Iterable<string>) => [...loaded].filter((id) => s.tabs[id] && hasPage(s.tabs[id]!) && !isSleeping(id));

export function tabsOverBudget(
  s: BrowserState,
  loaded: Iterable<string>,
  budget: LoadedTabBudget,
  now: number,
  seenAt: ReadonlyMap<string, number> = new Map(),
  askAgainAt: ReadonlyMap<string, number> = new Map(),
): string[] {
  const awake = awakeOf(s, loaded);
  if (awake.length <= budget.tabs) return [];
  const shown = new Set(withSharedFamily(s, withPinnedPanes(s, [...shownTabIds(s)])));
  const lastSeen = (id: string) => (shown.has(id) ? now : Math.max(s.tabs[id]!.lastActiveAt, seenAt.get(id) ?? 0));
  return awake
    .sort((a, b) => lastSeen(b) - lastSeen(a))
    .slice(budget.tabs)
    .filter(
      (id) =>
        !shown.has(id) &&
        now - lastSeen(id) >= budget.hiddenMs &&
        (askAgainAt.get(id) ?? 0) <= now &&
        tabEngine(s, id) === "chromium" &&
        /^https?:\/\//i.test(s.tabs[id]!.url) &&
        !inUse(s, id),
    )
    .reverse();
}

const seenAt = new Map<string, number>();
const askAgainAt = new Map<string, number>();
const sleptAt = new Map<string, number>();
let sweeping = false;

export async function sleepTabsOverBudget(budget: LoadedTabBudget | null, now = Date.now()): Promise<string[]> {
  if (!budget || sweeping) return [];
  const s = useBrowser.getState();
  for (const id of shownTabIds(s)) seenAt.set(id, now);
  for (const id of seenAt.keys()) if (!s.tabs[id]) seenAt.delete(id);
  for (const [id, at] of askAgainAt) if (!s.tabs[id] || at <= now) askAgainAt.delete(id);
  const slept: string[] = [];
  sweeping = true;
  try {
    for (const id of tabsOverBudget(s, webviews.keys(), budget, now, seenAt, askAgainAt).slice(0, SLEEPS_PER_SWEEP)) {
      const asked = Promise.resolve(webviews.get(id)?.sleepIfHidden(budget.hiddenMs / 1000)).catch(() => undefined);
      const keptBy = await withDeadline(asked, ANSWER_WITHIN_MS, undefined);
      if (keptBy?.length === 0) {
        slept.push(id);
        sleptAt.set(id, now);
        noteTabSleptOverBudget();
      } else if (keptBy?.includes(RECENTLY_VISIBLE)) seenAt.set(id, now);
      else askAgainAt.set(id, now + ASK_AGAIN_MS);
    }
  } finally {
    sweeping = false;
  }
  return slept;
}

export function noteTabWoke(tabId: string, now = Date.now()) {
  const at = sleptAt.get(tabId);
  if (at === undefined) return;
  sleptAt.delete(tabId);
  if (now - at < REOPENED_SOON_MS) noteTabSleptOverBudgetReopened();
}

export function noteTabGone(tabId: string) {
  sleptAt.delete(tabId);
}

let started = false;

export function startLoadedTabBudget(system: () => SystemState | null) {
  if (started) return;
  started = true;
  const budget = () => loadedTabBudget(useBrowser.getState().settings, system());
  everySlowly({
    every: SWEEP_MS,
    run: () => void sleepTabsOverBudget(budget()),
    needed: () => awakeOf(useBrowser.getState(), webviews.keys()).length > (budget()?.tabs ?? Infinity),
  });
  if (__DEV__) (globalThis as { acLoadedTabBudget?: unknown }).acLoadedTabBudget = { sleepTabsOverBudget, budget, tabsOverBudget };
}
