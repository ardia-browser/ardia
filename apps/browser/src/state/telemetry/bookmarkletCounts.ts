let runs = 0;
let refused = 0;

export function noteBookmarkletRun(ran: boolean) {
  if (ran) runs++;
  else refused++;
}

export function takeBookmarkletCounts() {
  const taken = { bookmarklet_runs: runs, bookmarklets_refused: refused };
  runs = 0;
  refused = 0;
  return taken;
}
