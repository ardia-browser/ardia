import { showInPlaceOf, type HostTab, type TabViewport } from "./hostTab.ts";
import { PEEK_MOVING_ATTRIBUTE } from "./peekStageMotion.ts";

type SwitchView = { tab: () => HostTab | null; slot: Element; regions: { setPage(slot: Element, visible: boolean): void; pageViewport?(slot: Element, rect: TabViewport["rect"]): void } };
type ActiveWindows = { windows: Record<string, { profileId: string; activeTabIds: Record<string, string> } | undefined> };
type ActiveStore = { subscribe(listener: (state: ActiveWindows, previous: ActiveWindows) => void): () => void };

const views = new Map<string, SwitchView>();
let switchedAhead = 0;
const MOVING_STAGE = `[${PEEK_MOVING_ATTRIBUTE}]`;
const inMovingStage = (view: SwitchView) => !!(view.slot as Partial<Pick<Element, "closest">>).closest?.(MOVING_STAGE);

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
  if (!from || !to || !fromTab || !toTab || inMovingStage(from) || inMovingStage(to)) return;
  for (const view of views.values()) if (view !== from && view.tab()?.shownViewport()) return;
  if (!showInPlaceOf(fromTab, toTab, (shown) => to.regions.pageViewport?.(to.slot, shown.rect))) return;
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
