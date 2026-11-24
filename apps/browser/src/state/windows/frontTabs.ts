import { useBrowser, type BrowserState } from "../browser/store";

type Fronts = Pick<BrowserState, "windows" | "tabs">;

export type FrontTabChange = { windowId: string; before: string | undefined; after: string | undefined };
export type FrontTabListener = (change: FrontTabChange, s: BrowserState) => void;

const frontOf = (s: Fronts, windowId: string) => {
  const w = s.windows[windowId];
  const id = w?.activeTabIds[w.profileId];
  return id && s.tabs[id]?.windowId === windowId ? id : undefined;
};

export function frontTabChanges(prev: Fronts, next: Fronts): FrontTabChange[] {
  if (prev.windows === next.windows) return [];
  const changes: FrontTabChange[] = [];
  for (const windowId of Object.keys(next.windows)) {
    const before = frontOf(prev, windowId);
    const after = frontOf(next, windowId);
    if (before !== after) changes.push({ windowId, before, after });
  }
  return changes;
}

export const tabsLeftInOpenWindows = (prev: Fronts, s: BrowserState) =>
  frontTabChanges(prev, s).flatMap(({ windowId, before }) => (before && s.windowOrder.includes(windowId) ? [before] : []));

const listeners = new Set<FrontTabListener>();
let stopWatching: (() => void) | null = null;
let dispatching = 0;

const stopIfUnwatched = () => {
  if (dispatching || listeners.size || !stopWatching) return;
  stopWatching();
  stopWatching = null;
};

function dispatch(s: BrowserState, prev: BrowserState) {
  const changes = frontTabChanges(prev, s);
  if (!changes.length) return;
  const audience = [...listeners];
  dispatching++;
  try {
    for (const change of changes) for (const each of audience) if (listeners.has(each)) each(change, s);
  } finally {
    dispatching--;
    stopIfUnwatched();
  }
}

export function onFrontTabChanged(listener: FrontTabListener): () => void {
  listeners.add(listener);
  stopWatching ??= useBrowser.subscribeTo(["windows"], dispatch);
  return () => {
    listeners.delete(listener);
    stopIfUnwatched();
  };
}
