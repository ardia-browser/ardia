import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import { useShowsEmptyWindow } from "../../state/windows/hooks";
import { noteSidebarEmptyWindowPeek } from "../../state/telemetry/usage";

type Peek = { live: boolean; show: () => void; hide: () => void };

export function emptyWindowPeekCount() {
  let asked = false;
  return {
    ask: (wanted: boolean) => void (asked = wanted),
    opened: () => {
      if (asked) noteSidebarEmptyWindowPeek();
      asked = false;
    },
    byHand: () => void (asked = false),
  };
}

export function useEmptyWindowPeek(windowId: string, enabled: boolean, peek: { current: Peek }) {
  const empty = useShowsEmptyWindow(windowId);
  const enabledNow = useRef(enabled);
  enabledNow.current = enabled;
  const shown = useRef(false);
  const count = useMemo(emptyWindowPeekCount, []);
  const showForEmpty = () => {
    shown.current = true;
    count.ask(true);
    peek.current.show();
  };
  useEffect(() => {
    if (empty && enabledNow.current) return showForEmpty();
    count.ask(false);
    const wasShown = shown.current;
    shown.current = false;
    if (wasShown) peek.current.hide();
  }, [empty]);
  useEffect(() => {
    if (!enabled) shown.current = false;
  }, [enabled]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => state === "active" && shown.current && !peek.current.live && showForEmpty());
    return () => sub.remove();
  }, []);
  return useMemo(() => ({ opened: count.opened, byHand: count.byHand, held: () => shown.current }), [count]);
}
