let clears = 0;
let entriesCleared = 0;

export function noteRecentlyClosedCleared(entries: number) {
  clears++;
  entriesCleared += entries;
}

export function takeRecentlyClosedCounts() {
  const taken = { recently_closed_clears: clears, recently_closed_entries_cleared: entriesCleared };
  clears = 0;
  entriesCleared = 0;
  return taken;
}
