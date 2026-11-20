let kept = 0;
let dropped = 0;

export function noteGroupMoveSplits(carried: number, restored: number) {
  kept += restored;
  dropped += carried - restored;
}

export function takeGroupMoveSplitCounts() {
  const taken = { group_move_splits_kept: kept, group_move_splits_dropped: dropped };
  kept = 0;
  dropped = 0;
  return taken;
}
