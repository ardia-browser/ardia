import { createContext, useContext, useLayoutEffect, useMemo, useState } from "react";
import type { PageBarMatch } from "../../state/plugins/pageBar";
import type { PageBarButton } from "../../lib/pluginPageBar";
import type { ToolbarPalette } from "../ui/toolbarColors";
import { PageBarButtons } from "./PageBarButtons";
import { usePageBars, watchPublishedPageBars, type PageBars, type PaneLayoutFacts } from "../../state/plugins/pageBarPanes";

type PageBarScopeValue = { windowId: string | null; wanted: boolean; bars: PageBars };

const NO_BARS: PageBars = {};
const OFF: PageBarScopeValue = { windowId: null, wanted: false, bars: NO_BARS };
export const PageBarContext = createContext<PageBarScopeValue>(OFF);

export function usePageBarScopeValue(windowId: string | null, wanted: boolean): PageBarScopeValue {
  const [bars, setBars] = useState<PageBars>(NO_BARS);
  useLayoutEffect(() => {
    if (!wanted || !windowId) return void setBars(NO_BARS);
    return watchPublishedPageBars(windowId, setBars);
  }, [wanted, windowId]);
  return useMemo(() => (wanted && windowId ? { windowId, wanted, bars } : OFF), [windowId, wanted, bars]);
}

export const usePageBarScope = () => useContext(PageBarContext);

export function usePageBarOf(windowId: string, tabId: string): PageBarMatch | null {
  const scope = usePageBarScope();
  return scope.windowId === windowId ? (scope.bars[tabId] ?? null) : null;
}

export function PageBarPublisher({ windowId, panes, small, fullscreen }: { windowId: string; panes: PaneLayoutFacts[]; small: boolean; fullscreen: boolean }) {
  usePageBars(windowId, panes, { small, fullscreen });
  return null;
}

const FIELD_ACTIONS: readonly PageBarButton[] = ["console", "network", "inspect"];

export function PageBarFieldButtons({ windowId, tabId, match, palette, onFocus }: { windowId: string; tabId: string; match: PageBarMatch; palette: ToolbarPalette; onFocus: () => void }) {
  return <PageBarButtons windowId={windowId} tabId={tabId} document={match} buttons={match.spec.buttons.filter((b) => FIELD_ACTIONS.includes(b))} palette={palette} look="field" onFocus={onFocus} />;
}
