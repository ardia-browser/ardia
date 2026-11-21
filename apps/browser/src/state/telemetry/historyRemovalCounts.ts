import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

const removed = { key: 0, button: 0, menu: 0 };
const rows = { key: 0, button: 0, menu: 0 };
let clears = 0;
let clearFailures = 0;

export function noteBrowsingDataCleared(ok: boolean, consent?: ConsentToken | null) {
  countFor(consent, () => void (ok ? clears++ : clearFailures++), { [ok ? "browsing_data_clears" : "browsing_data_clear_failures"]: 1 });
}

export function noteHistoryRowsRemoved(via: keyof typeof removed, count: number, consent?: ConsentToken | null) {
  countFor(consent, () => void (removed[via]++, (rows[via] += count)), { [`history_removals_by_${via}`]: 1, [`history_rows_removed_by_${via}`]: count });
}

export function takeHistoryRemovalCounts() {
  const taken = {
    history_removals_by_key: removed.key,
    history_removals_by_button: removed.button,
    history_removals_by_menu: removed.menu,
    history_rows_removed_by_key: rows.key,
    history_rows_removed_by_button: rows.button,
    history_rows_removed_by_menu: rows.menu,
    browsing_data_clears: clears,
    browsing_data_clear_failures: clearFailures,
  };
  clears = clearFailures = 0;
  for (const via of ["key", "button", "menu"] as const) removed[via] = rows[via] = 0;
  return taken;
}
