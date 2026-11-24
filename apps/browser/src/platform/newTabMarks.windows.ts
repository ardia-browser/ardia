import type { MarkNewTabBar, MarkNewTabPane } from "./newTabMarks";
export type { MarkNewTabBar, MarkNewTabPane, NewTabBarStage } from "./newTabMarks";

const STALL_MS = 40;
const WATCH_MS = 1500;
const TICK_MS = 4;

const typedTabs = new Set<string>();

function watchStalls(tabId: string) {
  const start = Date.now();
  let last = start;
  const tick = () => {
    const now = Date.now();
    if (now - last >= STALL_MS) console.info(`[ardia windows] js stall ${now - last} ms from +${last - start} ms after page ${tabId}`);
    last = now;
    if (now - start < WATCH_MS) setTimeout(tick, TICK_MS);
  };
  setTimeout(tick, TICK_MS);
}

export const markNewTabBar: MarkNewTabBar = (stage, tabId) => {
  if (stage === "page") {
    typedTabs.delete(tabId);
    watchStalls(tabId);
  }
  if (stage === "typed") {
    if (typedTabs.has(tabId)) return;
    typedTabs.add(tabId);
  }
  console.info(`[ardia windows] new tab bar ${stage} ${tabId}`);
};

export const markNewTabPane: MarkNewTabPane = (tabId, state) => console.info(`[ardia windows] new tab pane ${tabId} ${state}`);
