import { useEffect, useRef, useState } from "react";
import { useBrowser } from "../browser/store";
import { useTabLive, watchShownLive } from "../browser/hooks";
import { notePageOverlay } from "../telemetry/usage";
import { shownLiveOf } from "./tabLive";

const SHOW_AFTER_MS = 150;

export function useLastingLoad(tabId: string) {
  const loading = useTabLive(tabId, (live) => live.isLoading);
  const [lasting, setLasting] = useState(false);
  const waiting = useRef(false);
  useEffect(() => {
    if (!loading) {
      if (waiting.current) notePageOverlay("loadingSkipped");
      waiting.current = false;
      return;
    }
    waiting.current = true;
    const wait = setTimeout(() => {
      waiting.current = false;
      setLasting(true);
    }, SHOW_AFTER_MS);
    return () => {
      clearTimeout(wait);
      setLasting(false);
    };
  }, [loading]);
  return loading && lasting;
}

export function watchLastingLoad(tabId: string, changed: (lasting: boolean) => void): () => void {
  let loading = false;
  let lasting = false;
  let wait: ReturnType<typeof setTimeout> | undefined;
  const sync = () => {
    const now = shownLiveOf(useBrowser.getState(), tabId).isLoading;
    if (now === loading) return;
    loading = now;
    if (now) {
      wait = setTimeout(() => {
        wait = undefined;
        lasting = true;
        changed(true);
      }, SHOW_AFTER_MS);
      return;
    }
    if (wait !== undefined) notePageOverlay("loadingSkipped");
    clearTimeout(wait);
    wait = undefined;
    if (lasting) changed((lasting = false));
  };
  sync();
  const stop = watchShownLive(tabId, sync);
  return () => {
    stop();
    clearTimeout(wait);
  };
}
