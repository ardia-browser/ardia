import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useNavigation } from "../../state/browse/hooks";
import { useBrowse } from "../../state/browse/store";
import { useLibrary } from "../../state/library/store";
import { settingsNav } from "../../state/settings/nav";
import { usePreferences } from "../../state/settings/hooks";
import { currentPreferences, setPreference } from "../../state/settings/store";
import { showToast, TOAST_LONG_DURATION_MS } from "../../state/toasts/store";
import { useIncognito } from "../../state/tabs/hooks";
import { countUsage } from "../../state/telemetry/telemetry";
import type { TabPager } from "./TabPager";

export const TAB_SWIPE_HINT = { delayMs: 1500, text: "Swipe the bar sideways to switch tabs" } as const;

export function TabSwipeHint({ pager, toward, tabId, calm }: { pager: TabPager; toward: -1 | 0 | 1; tabId: string; calm: boolean }) {
  useTabSwipeHint(pager, toward, tabId, calm);
  return null;
}

function useTabSwipeHint(pager: TabPager, toward: -1 | 0 | 1, tabId: string, calm: boolean) {
  const shown = usePreferences((p) => p.tabSwipeHintShown);
  const incognito = useIncognito();
  const alone = useBrowse((s) => s.surface === "browsing" && s.sheet === null && s.opening === null && s.arriving === null);
  const settled = useNavigation(tabId, (page) => page?.isLive === true && !page.isLoading);
  const offered = Platform.OS === "android" && !shown && toward !== 0 && calm && alone && settled;
  const currentPager = useRef(pager);
  currentPager.current = pager;
  useEffect(() => {
    if (!offered) return;
    let timer: ReturnType<typeof setTimeout>;
    const offer = () => {
      if (currentPreferences().tabSwipeHintShown) return;
      if (settingsNav().open || useLibrary.getState().open || !currentPager.current.peek(toward === 1 ? 1 : -1)) {
        timer = setTimeout(offer, TAB_SWIPE_HINT.delayMs);
        return;
      }
      setPreference("tabSwipeHintShown", true);
      if (!incognito) countUsage("tab_swipe_hints_shown");
      showToast(TAB_SWIPE_HINT.text, "swipe", TOAST_LONG_DURATION_MS);
    };
    timer = setTimeout(offer, TAB_SWIPE_HINT.delayMs);
    return () => clearTimeout(timer);
  }, [offered, toward, tabId, incognito]);
}
