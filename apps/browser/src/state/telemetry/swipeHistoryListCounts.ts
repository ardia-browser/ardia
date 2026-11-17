const counts = { opened: 0, folded: 0 };

export type SwipeHistoryListStep = keyof typeof counts;

export const noteSwipeHistoryList = (step: SwipeHistoryListStep) => void (counts[step] += 1);

export function takeSwipeHistoryListCounts() {
  const taken = { swipe_history_list_opens: counts.opened, swipe_history_list_folds: counts.folded };
  counts.opened = 0;
  counts.folded = 0;
  return taken;
}
