let moves = 0;
let moved = 0;
let slowestSyncMs = 0;

export function noteBookmarksMoved(count: number) {
  moves++;
  moved += count;
}

export function noteBookmarkSyncDiff(ms: number) {
  if (ms > slowestSyncMs) slowestSyncMs = ms;
}

export function takeBookmarkMoveCounts() {
  const taken = { bookmark_moves: moves, bookmarks_moved: moved, bookmark_sync_diff_ms_max: Math.round(slowestSyncMs) };
  moves = 0;
  moved = 0;
  slowestSyncMs = 0;
  return taken;
}
