const removed = { key: 0, button: 0, menu: 0 };
const rows = { key: 0, button: 0, menu: 0 };

export function noteHistoryRowsRemoved(via: keyof typeof removed, count: number) {
  removed[via]++;
  rows[via] += count;
}

export function takeHistoryRemovalCounts() {
  const taken = {
    history_removals_by_key: removed.key,
    history_removals_by_button: removed.button,
    history_removals_by_menu: removed.menu,
    history_rows_removed_by_key: rows.key,
    history_rows_removed_by_button: rows.button,
    history_rows_removed_by_menu: rows.menu,
  };
  for (const via of ["key", "button", "menu"] as const) removed[via] = rows[via] = 0;
  return taken;
}
