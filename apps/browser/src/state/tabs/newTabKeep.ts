import { useLayoutEffect, useRef, useState } from "react";
import { useBrowser } from "../browser/store";
import { focusHeroBar } from "../omnibox/barState";
import { consentToken } from "../telemetry/client";
import { notePageOverlay } from "../telemetry/usage";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { navigationOf } from "./pageSession";
import { onLiveChange, shownLiveOf } from "./tabLive";

const NEW_TAB_KEPT_MAX_MS = 1500;
const NEW_TAB_DROP_AFTER_LOAD_MS = 100;

type Load = { seq: number; ended: boolean };
const loads = new Map<string, Load>();
const armed = new Map<string, number>();
let recording: (() => void) | null = null;

const navigationSeq = (tabId: string) => navigationOf(useBrowser.getState().tabs[tabId])?.seq;

function recordLoad(tabId: string, loading: boolean) {
  if (!armed.has(tabId)) return;
  const seq = navigationSeq(tabId);
  if (seq === undefined) return void loads.delete(tabId);
  if (loading) return void loads.set(tabId, { seq, ended: false });
  const load = loads.get(tabId);
  if (load?.seq === seq) load.ended = true;
}

export function armLoadRecord(tabId: string): () => void {
  armed.set(tabId, (armed.get(tabId) ?? 0) + 1);
  recording ??= onLiveChange((id, live, prev) => {
    if (live.isLoading !== prev.isLoading) recordLoad(id, live.isLoading);
  });
  return () => {
    const left = (armed.get(tabId) ?? 1) - 1;
    if (left > 0) return void armed.set(tabId, left);
    armed.delete(tabId);
    loads.delete(tabId);
    if (armed.size || !recording) return;
    recording();
    recording = null;
  };
}

const loadEnded = (tabId: string, seq: number | undefined) => {
  const load = loads.get(tabId);
  return seq !== undefined && load?.seq === seq && load.ended && !shownLiveOf(useBrowser.getState(), tabId).isLoading;
};

export function watchPageDrawn(tabId: string, seq: number | undefined, drawn: (timedOut: boolean) => void, maxMs = NEW_TAB_KEPT_MAX_MS, afterLoadMs = NEW_TAB_DROP_AFTER_LOAD_MS): () => void {
  const disarm = armLoadRecord(tabId);
  let afterLoad: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const end = () => {
    done = true;
    stop();
    disarm();
    clearTimeout(cap);
    clearTimeout(afterLoad);
  };
  const check = () => {
    if (!loadEnded(tabId, seq)) {
      clearTimeout(afterLoad);
      afterLoad = undefined;
    } else if (afterLoad === undefined) {
      afterLoad = setTimeout(() => {
        if (done) return;
        end();
        drawn(false);
      }, afterLoadMs);
    }
  };
  const stop = onLiveChange((id) => {
    if (id === tabId && !done) check();
  });
  const cap = setTimeout(() => {
    if (done) return;
    end();
    drawn(true);
  }, maxMs);
  check();
  return () => {
    if (!done) end();
  };
}

export function useNewTabKeptForPage(tabId: string, newTabShown: boolean, pageShown: boolean, appPage: boolean): boolean {
  const [shownBefore, setShownBefore] = useState(newTabShown);
  const [kept, setKept] = useState(false);
  if (shownBefore !== newTabShown) {
    setShownBefore(newTabShown);
    setKept(PLATFORM_FEATURES.keepsNewTabUntilPageLoads && !newTabShown && pageShown && !appPage);
  } else if (kept && appPage) setKept(false);
  const recordsLoads = PLATFORM_FEATURES.keepsNewTabUntilPageLoads && (newTabShown || kept);
  useLayoutEffect(() => (recordsLoads ? armLoadRecord(tabId) : undefined), [recordsLoads, tabId]);
  useLayoutEffect(() => {
    if (!kept) return;
    const consent = consentToken();
    notePageOverlay("newTabKeptForPage", consent);
    return watchPageDrawn(tabId, navigationSeq(tabId), (timedOut) => {
      if (timedOut) notePageOverlay("newTabKeptTimedOut", consent);
      setKept(false);
    });
  }, [kept, tabId]);
  return kept;
}

export function useHeroBarFocusWhenShownAgain(windowId: string, tabId: string, kept: boolean) {
  const keptBefore = useRef(kept);
  useLayoutEffect(() => {
    if (keptBefore.current && !kept) focusHeroBar(windowId, tabId, "restore");
    keptBefore.current = kept;
  }, [kept, windowId, tabId]);
}
