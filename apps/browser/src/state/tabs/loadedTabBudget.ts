import type { SystemState } from "../../platform/performance";
import { everySlowly, reschedule } from "../../platform/slowTimers";
import { onWebviewsChanged, webviews } from "../../platform/webviews";
import { afterFirstRoot } from "../../lib/afterFirstWindow";
import { withDeadline } from "../../lib/deadline";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { useBrowser, type BrowserState } from "../browser/store";
import { tabEngine } from "../engines/engines";
import { isPlaying, useMedia } from "../media/media";
import { withSharedFamily } from "../pins/pinShare";
import type { Settings } from "../settings/settings";
import { withPinnedPanes } from "../splits/splits";
import { noteBudgetSweep, noteSleepVeto, noteTabSleptOverBudget, noteTabSleptOverBudgetReopened } from "../telemetry/tabSleepCounts";
import { consentToken, stillValid } from "../telemetry/client";
import type { ConsentToken } from "../telemetry/choice";
import { hasPage } from "./pageSession";
import { usePages } from "./pageState";
import { shownTabIds } from "./shownTabs";
import { isSleeping, useLifecycle } from "./sleepingTabs";
import { engineVeto, MINUTE, sleepRules, sleepVeto, tabsToSleep, type SleepPlan, type SleepRules, type SleepVeto, type TabSleepFacts } from "./sleepPolicy";
import { liveOf, onLiveChange } from "./tabLive";
import { countSwitch, forgetSwitchesExcept, switchesOf } from "./tabSwitches";
import { onFrontTabChanged } from "../windows/frontTabs";
import { heldByCli } from "./cliHolds";

type LoadedTabBudget = Pick<SleepRules, "tabs" | "hiddenMs"> & Partial<SleepRules>;

const SWEEP_MS = MINUTE;
const PRESSURE_TICK_MS = 5_000;
const PRESSURE_ARMS_AFTER_MS = 10_000;
const ANSWER_WITHIN_MS = 1500;
const ASK_AGAIN_MS = 10 * MINUTE;
const KEPT_RECENTLY_MS = 60 * MINUTE;
const REOPENED_SOON_MS = 30 * MINUTE;

export function loadedTabBudget(settings: Pick<Settings, "memorySaver" | "memorySaverMode">, sys: SystemState | null): LoadedTabBudget | null {
  if (!PLATFORM_FEATURES.sleepsTabsOverBudget) return null;
  return sleepRules(settings, sys);
}

const capturing = (id: string) => {
  const media = useMedia.getState();
  const access = usePages.getState().pages[id]?.mediaAccess;
  return !!(access && (access.camera || access.microphone || access.screen)) || !!media.tabShares[id] || Object.values(media.tabShares).some((share) => share.capturedTabId === id);
};

const audibleNow = (id: string) => liveOf(id).playingAudio || isPlaying(useMedia.getState().sessions[id]);

export function inUse(s: BrowserState, id: string): boolean {
  return audibleNow(id) || !!useMedia.getState().pipOpen[id] || capturing(id);
}

const awakeOf = (s: BrowserState, loaded: Iterable<string>) => [...loaded].filter((id) => s.tabs[id] && hasPage(s.tabs[id]!) && !isSleeping(id));

const lastAudibleAt = new Map<string, number>();

function sleepFacts(s: BrowserState, id: string, shown: ReadonlySet<string>, seenAt: ReadonlyMap<string, number>, askAgainAt: ReadonlyMap<string, number>): TabSleepFacts {
  const tab = s.tabs[id]!;
  return {
    id,
    sleepable: tabEngine(s, id) === "chromium" && /^https?:\/\//i.test(tab.url),
    shown: shown.has(id),
    cliSession: heldByCli(id),
    lastSeenAt: Math.max(tab.lastActiveAt, seenAt.get(id) ?? 0),
    switches: switchesOf(id),
    audible: audibleNow(id),
    lastAudibleAt: lastAudibleAt.get(id) ?? 0,
    call: capturing(id),
    pictureInPicture: !!useMedia.getState().pipOpen[id],
    loading: liveOf(id).isLoading,
    askAgainAt: askAgainAt.get(id) ?? 0,
  };
}

export function planOverBudget(
  s: BrowserState,
  loaded: Iterable<string>,
  budget: LoadedTabBudget,
  now: number,
  seenAt: ReadonlyMap<string, number> = new Map(),
  askAgainAt: ReadonlyMap<string, number> = new Map(),
): SleepPlan {
  const awake = awakeOf(s, loaded);
  if (awake.length <= budget.tabs) return { sleep: [], vetoed: [] };
  const shown = new Set(withSharedFamily(s, withPinnedPanes(s, [...shownTabIds(s)])));
  return tabsToSleep(
    awake.map((id) => sleepFacts(s, id, shown, seenAt, askAgainAt)),
    now,
    { tabs: budget.tabs, hiddenMs: budget.hiddenMs, pressure: budget.pressure ?? "normal" },
  );
}

export function tabsOverBudget(
  s: BrowserState,
  loaded: Iterable<string>,
  budget: LoadedTabBudget,
  now: number,
  seenAt: ReadonlyMap<string, number> = new Map(),
  askAgainAt: ReadonlyMap<string, number> = new Map(),
  skippedLoading: string[] = [],
): string[] {
  const plan = planOverBudget(s, loaded, budget, now, seenAt, askAgainAt);
  for (const { id, veto } of plan.vetoed) if (veto === "loading") skippedLoading.push(id);
  return plan.sleep;
}

const COUNTED_VETOES: ReadonlySet<SleepVeto> = new Set(["cliSession", "call", "pictureInPicture", "audible", "recentlyAudible", "frequentlyUsed", "typedInput", "postedDocument", "beforeUnload", "download", "other"]);
const countedVetoes = new Set<string>();
let countedIn: ConsentToken | null = null;

function noteVeto(id: string, veto: SleepVeto | null, consent: ConsentToken | null) {
  if (!veto || !COUNTED_VETOES.has(veto) || !stillValid(consent)) return;
  if (countedIn !== consent) {
    countedVetoes.clear();
    countedIn = consent;
  }
  const key = `${id}\n${veto}`;
  if (countedVetoes.has(key)) return;
  countedVetoes.add(key);
  noteSleepVeto(veto, consent);
}

const vetoedTabOf = (key: string) => key.slice(0, key.indexOf("\n"));

function vetoNow(id: string, budget: LoadedTabBudget, now: number): SleepVeto | "gone" | null {
  const s = useBrowser.getState();
  if (!s.tabs[id] || !webviews.has(id) || isSleeping(id)) return "gone";
  const shown = new Set(withSharedFamily(s, withPinnedPanes(s, [...shownTabIds(s)])));
  return sleepVeto(sleepFacts(s, id, shown, seenAt, askAgainAt), now, { hiddenMs: budget.hiddenMs, pressure: budget.pressure ?? "normal" });
}

const seenAt = new Map<string, number>();
const askAgainAt = new Map<string, number>();
const sleptAt = new Map<string, number>();
const keptAt = new Map<string, number>();
let sweeping = false;
let lastAutomaticSweepAt = -Infinity;
let pressureGeneration = 0;
let pressureArmed = false;

export const sleepTabsOverBudget = (budget: LoadedTabBudget | null, now = Date.now()) => sweepOverBudget(budget, now, consentToken());

async function sweepOverBudget(budget: LoadedTabBudget | null, now: number, consent: ConsentToken | null): Promise<string[]> {
  if (!budget || sweeping) return [];
  const generation = pressureGeneration;
  const s = useBrowser.getState();
  for (const id of shownTabIds(s)) seenAt.set(id, now);
  for (const id of seenAt.keys()) if (!s.tabs[id]) seenAt.delete(id);
  for (const id of lastAudibleAt.keys()) if (!s.tabs[id]) lastAudibleAt.delete(id);
  for (const key of countedVetoes) if (!s.tabs[vetoedTabOf(key)]) countedVetoes.delete(key);
  forgetSwitchesExcept(s.tabs);
  for (const [id, at] of askAgainAt) if (!s.tabs[id] || at <= now) askAgainAt.delete(id);
  for (const [id, at] of keptAt) if (!s.tabs[id] || now - at >= KEPT_RECENTLY_MS) keptAt.delete(id);
  const plan = planOverBudget(s, webviews.keys(), budget, now, seenAt, askAgainAt);
  for (const { id, veto } of plan.vetoed) noteVeto(id, veto, consent);
  const candidates = plan.sleep;
  const perTick = budget.perTick ?? 4;
  const asking = [...candidates.filter((id) => !keptAt.has(id)), ...candidates.filter((id) => keptAt.has(id))].slice(0, perTick);
  noteBudgetSweep(plan.vetoed.filter((v) => v.veto === "loading").length, candidates.slice(0, perTick).filter((id) => !asking.includes(id)).length, consent);
  const slept: string[] = [];
  sweeping = true;
  try {
    for (const id of asking) {
      if (generation !== pressureGeneration) break;
      const vetoed = vetoNow(id, budget, now);
      if (vetoed) {
        if (vetoed !== "gone") noteVeto(id, vetoed, consent);
        continue;
      }
      const asked = Promise.resolve(webviews.get(id)?.sleepIfHidden(budget.hiddenMs / 1000)).catch(() => undefined);
      const keptBy = await withDeadline(asked, ANSWER_WITHIN_MS, undefined);
      const veto = keptBy ? engineVeto(keptBy) : null;
      if (keptBy?.length === 0) {
        slept.push(id);
        sleptAt.set(id, now);
        keptAt.delete(id);
        noteTabSleptOverBudget(consent, budget.pressure ?? "normal");
      } else if (veto === "recentlySeen") seenAt.set(id, now);
      else {
        noteVeto(id, veto, consent);
        askAgainAt.set(id, now + ASK_AGAIN_MS);
        keptAt.set(id, now);
      }
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

function noteAudibleEnded(tabId: string, now = Date.now()) {
  lastAudibleAt.set(tabId, now);
}

let started = false;
let budgetNow: () => LoadedTabBudget | null = () => null;

const overBudget = (budget: LoadedTabBudget | null) => !!budget && awakeOf(useBrowser.getState(), webviews.keys()).length > budget.tabs;

const underPressure = (budget: LoadedTabBudget | null) => !!budget?.pressure && budget.pressure !== "normal";

export function sweepIfDue(budget: LoadedTabBudget | null, consent: ConsentToken | null, at = Date.now()): Promise<string[]> {
  if (!budget || sweeping || (underPressure(budget) && !pressureArmed)) return Promise.resolve([]);
  if (at - lastAutomaticSweepAt < (budget.everyMs ?? SWEEP_MS)) return Promise.resolve([]);
  lastAutomaticSweepAt = at;
  return sweepOverBudget(budget, at, consent);
}

export function pressureChanged(consent: ConsentToken | null, budget = budgetNow(), at = Date.now()) {
  pressureGeneration++;
  if (underPressure(budget) && overBudget(budget)) void sweepIfDue(budget, consent, at);
  reschedule();
}

export function watchOverBudget(budget: () => LoadedTabBudget | null, changed: () => void): () => void {
  let was = overBudget(budget());
  const check = () => {
    const now = overBudget(budget());
    if (now === was) return;
    was = now;
    changed();
  };
  const stopViews = onWebviewsChanged(check);
  const stopLifecycle = useLifecycle.subscribe(check);
  return () => {
    stopViews();
    stopLifecycle();
  };
}

export function armPressureSweeps() {
  pressureArmed = true;
  reschedule();
}

export function startLoadedTabBudget(system: () => SystemState | null) {
  if (started) return;
  started = true;
  const budget = (budgetNow = () => loadedTabBudget(useBrowser.getState().settings, system()));
  onFrontTabChanged((change) => countSwitch(change));
  onLiveChange((tabId, live, prev) => {
    if (prev.playingAudio && !live.playingAudio) noteAudibleEnded(tabId);
  });
  everySlowly({
    every: SWEEP_MS,
    run: () => void sweepIfDue(budget(), consentToken()),
    needed: () => overBudget(budget()),
    watch: (changed) => watchOverBudget(budget, changed),
  });
  everySlowly({
    every: PRESSURE_TICK_MS,
    run: () => void sweepIfDue(budget(), consentToken()),
    needed: () => pressureArmed && underPressure(budget()) && overBudget(budget()),
    watch: (changed) => watchOverBudget(budget, changed),
  });
  afterFirstRoot(() => setTimeout(armPressureSweeps, PRESSURE_ARMS_AFTER_MS));
  if (__DEV__) (globalThis as { acLoadedTabBudget?: unknown }).acLoadedTabBudget = { sleepTabsOverBudget, budget, tabsOverBudget, planOverBudget };
}
