import type { ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

const NO_COUNTS = {
  busy_tab_watch_ticks: 0,
  busy_tab_owner_lookups: 0,
  busy_tab_warnings: 0,
  busy_tab_slept: 0,
  busy_tab_kept_running: 0,
  busy_tab_stayed_awake: 0,
  busy_tab_sleep_moot: 0,
  busy_tab_warnings_turned_off: 0,
  busy_tab_warnings_turned_on: 0,
};

type BusyTabCount = keyof typeof NO_COUNTS;

let counts = { ...NO_COUNTS };

export function noteBusyTab(count: BusyTabCount, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void counts[count]++);
}

export function takeBusyTabCounts() {
  const taken = counts;
  counts = { ...NO_COUNTS };
  return taken;
}
