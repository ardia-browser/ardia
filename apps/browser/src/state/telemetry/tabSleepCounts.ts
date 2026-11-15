const none = () => ({ captureIndicatorsCleared: 0, pinnedTabsSleptByMemorySaver: 0, tabsSleptOverBudget: 0, tabsSleptOverBudgetReopened: 0 });

let pending = none();

export function noteCaptureIndicatorCleared() {
  pending.captureIndicatorsCleared++;
}

export function noteTabSlept(pinned: boolean, reason: string | null) {
  if (pinned && reason === "proactive") pending.pinnedTabsSleptByMemorySaver++;
}

export function noteTabSleptOverBudget() {
  pending.tabsSleptOverBudget++;
}

export function noteTabSleptOverBudgetReopened() {
  pending.tabsSleptOverBudgetReopened++;
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

export function takeTabSleepCounts() {
  const taken = pending;
  pending = none();
  return {
    capture_indicators_cleared: taken.captureIndicatorsCleared,
    pinned_tabs_slept_by_memory_saver: taken.pinnedTabsSleptByMemorySaver,
    ...takeProfileUnloadCounts(),
    tabs_slept_over_budget: taken.tabsSleptOverBudget,
    tabs_slept_over_budget_reopened: taken.tabsSleptOverBudgetReopened,
  };
}
