import { showInPlaceOf, type HostTab } from "./hostTab.ts";

export type SwitchView = { tab: () => HostTab | null; slot: Element; regions: { setPage(slot: Element, visible: boolean): void } };
type ActiveWindows = { windows: Record<string, { profileId: string; activeTabIds: Record<string, string> } | undefined> };
type ActiveStore = { subscribe(listener: (state: ActiveWindows, previous: ActiveWindows) => void): () => void };

const views = new Map<string, SwitchView>();
let switchedAhead = 0;

export function registerSwitchView(tabId: string, view: SwitchView) {
  views.set(tabId, view);
  return () => {
    if (views.get(tabId) === view) views.delete(tabId);
  };
}

export const tabsSwitchedAhead = () => switchedAhead;

function switchAhead(fromId: string, toId: string) {
  const from = views.get(fromId);
  const to = views.get(toId);
  const fromTab = from?.tab();
  const toTab = to?.tab();
  if (!from || !to || !fromTab || !toTab) return;
  for (const view of views.values()) if (view !== from && view.tab()?.shownViewport()) return;
  if (!showInPlaceOf(fromTab, toTab)) return;
  switchedAhead++;
  to.regions.setPage(to.slot, true);
  from.regions.setPage(from.slot, false);
}

export function watchTabSwitches(store: ActiveStore) {
  return store.subscribe((state, previous) => {
    if (state.windows === previous.windows) return;
    for (const [id, window] of Object.entries(state.windows)) {
      const before = previous.windows[id];
      if (!window || !before || before.profileId !== window.profileId) continue;
      const next = window.activeTabIds[window.profileId];
      const last = before.activeTabIds[window.profileId];
      if (next && last && next !== last) switchAhead(last, next);
    }
  });
}

export function forgetSwitchViews() {
  views.clear();
  switchedAhead = 0;
}
