import type { DiagnosticsSample } from "../../platform/app";
import { menuSyncTotals } from "../app/menuSyncTotals";

type Totals = { at: number; cpuMs: number; wakeups: number; rebuilds: number; stalePresses: number; scrollWaits: number; activatingPresses: number; menuBuilds: number; menuSends: number };

let last: Totals | null = null;

const totalsOf = (sample: DiagnosticsSample, at: number): Totals | null =>
  typeof sample.cpuMs === "number" && typeof sample.wakeups === "number"
    ? { at, cpuMs: sample.cpuMs, wakeups: sample.wakeups, rebuilds: sample.dragRegionRebuilds ?? 0, stalePresses: sample.dragRegionStalePresses ?? 0, scrollWaits: sample.dragRegionScrollWaits ?? 0, activatingPresses: sample.dragRegionActivatingPresses ?? 0, menuBuilds: menuSyncTotals.builds, menuSends: menuSyncTotals.sends }
    : null;

export function mainProcessWork(sample: DiagnosticsSample, at: number) {
  const now = totalsOf(sample, at);
  const before = last;
  last = now;
  const seconds = now && before ? (now.at - before.at) / 1000 : 0;
  if (!now || !before || seconds < 60 || now.cpuMs < before.cpuMs) return {};
  return {
    browser_cpu_pct: Math.round(((now.cpuMs - before.cpuMs) / (seconds * 1000)) * 1000) / 10,
    browser_wakeups_per_s: Math.round(((now.wakeups - before.wakeups) / seconds) * 10) / 10,
    drag_region_rebuilds: now.rebuilds - before.rebuilds,
    drag_region_stale_presses: now.stalePresses - before.stalePresses,
    drag_region_scroll_waits: now.scrollWaits - before.scrollWaits,
    drag_region_activating_presses: now.activatingPresses - before.activatingPresses,
    menu_state_builds: now.menuBuilds - before.menuBuilds,
    menu_state_sends: now.menuSends - before.menuSends,
  };
}

export const forgetMainProcessWork = () => void (last = null);
