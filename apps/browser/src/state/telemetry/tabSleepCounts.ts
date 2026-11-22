import { takeCleanUpCounts } from "./cleanUpCounts";
import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";
import type { KeptAwakeReason } from "../tabs/sleepRefusals";

const none = () => ({ captureIndicatorsCleared: 0, mediaCardsCleared: 0, pinnedTabsSleptByMemorySaver: 0, tabsSleptOverBudget: 0, tabsSleptOverBudgetReopened: 0, tabsOverBudgetSkippedLoading: 0, tabsOverBudgetAsksPassedOn: 0, topAppsKeptRunning: 0, topAppWindowsClosedFromNewTab: 0, topAppsUnloadedFromMenu: 0, tabsSleptFromMenu: 0, groupsSleptFromMenu: 0, menuSleepsKeptAwake: 0, menuSleepsPastAutomatic: 0, menuSleepKeptReason: null as KeptAwakeReason | null });

let pending = none();

export function noteCaptureIndicatorCleared() {
  pending.captureIndicatorsCleared++;
}

export function noteMediaCardCleared() {
  pending.mediaCardsCleared++;
}

export function noteTabSlept(pinned: boolean, reason: string | null) {
  if (pinned && reason === "proactive") pending.pinnedTabsSleptByMemorySaver++;
}

export function noteTabSleptOverBudget(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void pending.tabsSleptOverBudget++);
}

export function noteTabSleptOverBudgetReopened() {
  pending.tabsSleptOverBudgetReopened++;
}

export function noteBudgetSweep(skippedLoading: number, asksPassedOn: number) {
  pending.tabsOverBudgetSkippedLoading += skippedLoading;
  pending.tabsOverBudgetAsksPassedOn += asksPassedOn;
}

let profilesUnloaded = 0;
let unloadedProfilesReopened = 0;
let unloadedProfileReloadMs = 0;

export const noteProfileUnloaded = () => void profilesUnloaded++;

export const noteUnloadedProfileReopened = () => void unloadedProfilesReopened++;

export const noteUnloadedProfileReloaded = (ms: number) => void (unloadedProfileReloadMs += Math.max(0, Math.round(ms)));

function takeProfileUnloadCounts() {
  const taken = { profiles_unloaded: profilesUnloaded, unloaded_profiles_reopened: unloadedProfilesReopened, unloaded_profile_reload_ms: unloadedProfileReloadMs };
  profilesUnloaded = 0;
  unloadedProfilesReopened = 0;
  unloadedProfileReloadMs = 0;
  return taken;
}

export function noteTopAppsKeptRunning(count: number) {
  pending.topAppsKeptRunning += count;
}

export function noteTopAppWindowClosedFromNewTab(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void pending.topAppWindowsClosedFromNewTab++);
}

export function noteTopAppUnloadedFromMenu() {
  pending.topAppsUnloadedFromMenu++;
}

export function noteTabsSleptFromMenu(from: "tab" | "group", results: { outcome: string; keptBy?: KeptAwakeReason; pastAutomatic?: boolean }[], consent?: ConsentToken | null) {
  const keptAwake = results.filter((r) => r.outcome === "kept").length;
  const pastAutomatic = results.filter((r) => r.pastAutomatic).length;
  const keptReason = [...results].reverse().find((r) => r.keptBy)?.keptBy;
  const key = from === "tab" ? "tabsSleptFromMenu" : "groupsSleptFromMenu";
  countFor(consentOrNow(consent), () => {
    pending[key]++;
    pending.menuSleepsKeptAwake += keptAwake;
    pending.menuSleepsPastAutomatic += pastAutomatic;
    if (keptReason) pending.menuSleepKeptReason = keptReason;
  });
}

export function takeTabSleepCounts() {
  const taken = pending;
  pending = none();
  return {
    capture_indicators_cleared: taken.captureIndicatorsCleared,
    media_cards_cleared: taken.mediaCardsCleared,
    pinned_tabs_slept_by_memory_saver: taken.pinnedTabsSleptByMemorySaver,
    top_app_closes_kept_running: taken.topAppsKeptRunning,
    top_app_windows_closed_from_new_tab: taken.topAppWindowsClosedFromNewTab,
    top_apps_unloaded_from_menu: taken.topAppsUnloadedFromMenu,
    tabs_slept_from_menu: taken.tabsSleptFromMenu,
    groups_slept_from_menu: taken.groupsSleptFromMenu,
    menu_sleeps_kept_awake: taken.menuSleepsKeptAwake,
    menu_sleeps_past_automatic: taken.menuSleepsPastAutomatic,
    ...(taken.menuSleepKeptReason ? { menu_sleep_kept_reason: taken.menuSleepKeptReason } : {}),
    ...takeProfileUnloadCounts(),
    ...takeCleanUpCounts(),
    tabs_slept_over_budget: taken.tabsSleptOverBudget,
    tabs_slept_over_budget_reopened: taken.tabsSleptOverBudgetReopened,
    tabs_over_budget_skipped_loading: taken.tabsOverBudgetSkippedLoading,
    tabs_over_budget_asks_passed_on: taken.tabsOverBudgetAsksPassedOn,
  };
}
