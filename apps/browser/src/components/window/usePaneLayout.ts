import { useEffect, useMemo, useRef, useState } from "react";
import { newTabLingeringOver, successorWhenLeaving, useMountedTabIds, useShownPaneKeys, useSplitsOf, useWarmTabIds, wakePanes } from "../../state/windows/card";
import { pagerFor } from "../../state/windows/profilePager";
import { useTabDrag } from "../../state/drag/tabDrag";
import type { SplitView } from "../../state/browser/types";
import { splitGeometry, type Rect } from "./geometry";
import { splitTabIds } from "../../state/splits/splits";
import { notePageOverlay } from "../../state/telemetry/usage";
import { consentToken } from "../../state/telemetry/client";

const NEW_TAB_LINGER_MS = 400;
const NEW_TAB_LINGER_LATE_MS = 100;

export function usePaneLayout(windowId: string, activeId: string | undefined, split: SplitView | undefined, fullscreenTab: string | undefined, size: { width: number; height: number }, gap: number) {
  const mounted = useMountedTabIds(windowId);

  const mountedIds = useMemo(() => new Set(mounted), [mounted]);

  const { panes, dividers } = useMemo(() => {
    const full: Rect = { x: 0, y: 0, width: size.width, height: size.height };
    if (fullscreenTab) {
      const under = split && splitTabIds(split).includes(fullscreenTab) ? splitGeometry(split, size.width, size.height, gap).panes : {};
      return { panes: { ...under, [fullscreenTab]: full }, dividers: [] };
    }
    if (split) return splitGeometry(split, size.width, size.height, gap);
    return { panes: activeId ? { [activeId]: full } : {}, dividers: [] };
  }, [split, activeId, fullscreenTab, size.width, size.height, gap]);

  useEffect(() => wakePanes(Object.keys(panes)), [panes]);

  const shownBefore = useRef(activeId);
  const linger = useMemo(() => {
    const from = shownBefore.current;
    return { id: from === activeId || fullscreenTab ? undefined : newTabLingeringOver(windowId, from, activeId, mounted) };
  }, [activeId]);
  useEffect(() => {
    shownBefore.current = activeId;
  }, [activeId]);
  const [expired, setExpired] = useState<typeof linger | null>(null);
  const lingerId = expired === linger ? undefined : linger.id;
  useEffect(() => {
    if (!linger.id) return;
    const consent = consentToken();
    const due = Date.now() + NEW_TAB_LINGER_MS;
    const timer = setTimeout(() => {
      if (Date.now() - due > NEW_TAB_LINGER_LATE_MS) notePageOverlay("newTabLingerLate", consent);
      setExpired(linger);
    }, NEW_TAB_LINGER_MS);
    return () => clearTimeout(timer);
  }, [linger]);
  const lingerRect: Rect | undefined = lingerId && size.width > 0 ? { x: 0, y: 0, width: size.width, height: size.height } : undefined;
  const shownPanes = useMemo(() => (lingerId && lingerRect ? { ...panes, [lingerId]: lingerRect } : panes), [panes, lingerId, lingerRect?.width, lingerRect?.height]);

  const pagerPages = pagerFor(windowId).state((st) => st.pages);
  const leaving = useTabDrag((d) => (d.phase === "tab" && d.windowId === windowId && (d.outside || !!(d.lifted ?? d.onPage)) ? d.tabIds : null));
  const successor = useMemo(() => (leaving ? successorWhenLeaving(leaving, windowId) : undefined), [leaving, windowId]);
  const warm = useWarmTabIds(windowId, pagerPages, successor);
  const warmSplits = useSplitsOf(warm);
  const warmPanes = useMemo(() => {
    const out: Record<string, Rect> = {};
    for (const id of warm) out[id] = { x: 0, y: 0, width: size.width, height: size.height };
    for (const v of warmSplits) Object.assign(out, splitGeometry(v, size.width, size.height, gap).panes);
    return out;
  }, [warm, warmSplits, size.width, size.height, gap]);

  const shown = useShownPaneKeys(mounted, shownPanes);

  return { mountedIds, panes, dividers, warmPanes, shown, lingerId: lingerRect ? lingerId : undefined, lingerRect };
}
