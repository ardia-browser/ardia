import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PageOverlayRegion } from "./PageOverlayRegion";
import { AutoHideToolbar as BrowserAutoHideToolbar } from "../../browser/src/components/toolbar/AutoHideToolbar";
import { TOOLBAR_MOTION } from "../../browser/src/components/toolbar/tokens";
import type { ToolbarMode } from "../../browser/src/state/windows/toolbarAutoHide";

export * from "../../browser/src/components/toolbar/AutoHideToolbar";

const MOTION_MS = Math.max(TOOLBAR_MOTION.show, TOOLBAR_MOTION.hide);
const movingUntil = new Map<string, number>();

export const toolbarMoving = (tabId: string) => (movingUntil.get(tabId) ?? 0) > performance.now();

export function AutoHideToolbar(props: React.ComponentProps<typeof BrowserAutoHideToolbar>) {
  const foldedAway = useFoldedAway(props.mode);
  useMotionWindow(props.tabId, props.mode);
  return (
    <PageOverlayRegion testID="ardia-auto-hide-toolbar" capturing={!foldedAway}>
      <BrowserAutoHideToolbar {...props} />
    </PageOverlayRegion>
  );
}

function useFoldedAway(mode: ToolbarMode) {
  const [fold, setFold] = useState({ mode, done: mode === "collapsed" });
  const current = fold.mode === mode ? fold : { mode, done: false };
  if (current !== fold) setFold(current);
  const entered = useRef({ mode, at: -Infinity });
  useLayoutEffect(() => {
    const from = entered.current;
    if (from.mode !== mode) entered.current = { mode, at: performance.now() };
    if (mode !== "collapsed" || current.done) return;
    const settledOpen = from.mode === "shown" && performance.now() - from.at >= TOOLBAR_MOTION.show;
    if (settledOpen) return void setFold({ mode, done: true });
    const timer = setTimeout(() => setFold({ mode: "collapsed", done: true }), TOOLBAR_MOTION.hide);
    return () => clearTimeout(timer);
  }, [mode, current.done]);
  return current.mode === "collapsed" && current.done;
}

function useMotionWindow(tabId: string, mode: ToolbarMode) {
  const was = useRef(mode);
  useLayoutEffect(() => {
    if (was.current === mode) return;
    was.current = mode;
    movingUntil.set(tabId, performance.now() + MOTION_MS * 2);
  }, [tabId, mode]);
  useEffect(() => () => void movingUntil.delete(tabId), [tabId]);
}
