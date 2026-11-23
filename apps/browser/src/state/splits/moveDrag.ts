import { create } from "zustand";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteSplitPaneDragCancel } from "../telemetry/splitReorderCounts";

export type ActiveSplitMoveDrag = {
  windowId: string;
  tabId: string;
  start: { x: number; y: number };
  dx: number;
  dy: number;
  moved: boolean;
  consent: ConsentToken | null;
};

type CommitHandler = (drag: ActiveSplitMoveDrag, dx: number, dy: number) => void;

const useMoveDragStore = create<{ drag: ActiveSplitMoveDrag | null }>()(() => ({ drag: null }));
const commitHandlers = new Map<string, CommitHandler>();
let cancelled = false;

export function registerSplitMoveCommit(windowId: string, handler: CommitHandler | null) {
  if (handler) commitHandlers.set(windowId, handler);
  else commitHandlers.delete(windowId);
}

export function beginSplitMoveDrag(windowId: string, tabId: string, start: { x: number; y: number }) {
  cancelled = false;
  useMoveDragStore.setState({
    drag: { windowId, tabId, start, dx: 0, dy: 0, moved: false, consent: consentToken() },
  });
}

export function updateSplitMoveDrag(windowId: string, tabId: string, dx: number, dy: number, dragSlop: number) {
  if (cancelled) return;
  const cur = useMoveDragStore.getState().drag;
  if (!cur || cur.windowId !== windowId || cur.tabId !== tabId) return;
  const moved = cur.moved || Math.hypot(dx, dy) >= dragSlop;
  useMoveDragStore.setState({ drag: { ...cur, dx, dy, moved } });
}

export function finishSplitMoveDrag(windowId: string, tabId: string, dx: number, dy: number) {
  const cur = useMoveDragStore.getState().drag;
  if (!cur || cur.windowId !== windowId || cur.tabId !== tabId) return;
  const wasCancelled = cancelled;
  cancelled = false;
  useMoveDragStore.setState({ drag: null });
  if (!wasCancelled) commitHandlers.get(cur.windowId)?.(cur, dx, dy);
}

export function cancelSplitMoveDrag(recordCancel: boolean, windowId?: string, tabId?: string) {
  const cur = useMoveDragStore.getState().drag;
  if (windowId && cur && (cur.windowId !== windowId || (tabId && cur.tabId !== tabId))) return;
  cancelled = true;
  if (recordCancel && cur?.moved) noteSplitPaneDragCancel(cur.consent);
  useMoveDragStore.setState({ drag: null });
}

export const useSplitMoveDrag = (windowId: string) =>
  useMoveDragStore((s) => (s.drag?.windowId === windowId ? s.drag : null));
