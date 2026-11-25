const live = new Map<string, number>();
let doubled = 0;

export function noteWindowRoot(windowId: string) {
  const roots = (live.get(windowId) ?? 0) + 1;
  live.set(windowId, roots);
  if (roots > 1) doubled += 1;
  return () => {
    const left = (live.get(windowId) ?? 1) - 1;
    if (left > 0) live.set(windowId, left);
    else live.delete(windowId);
  };
}

export function takeWindowRootCounts() {
  const taken = { window_roots_doubled: doubled };
  doubled = 0;
  return taken;
}
