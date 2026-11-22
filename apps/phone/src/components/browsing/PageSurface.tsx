import { useEffect, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { ARRIVAL_COVER_ID, OPENING_COVER_ID, pageCoverHidden, pageDrawn, pageOpenFailed, pageStateChanged, pageToneChanged, swipedPastHistory } from "../../state/browse/store";
import { useNavigation, usePageArriving, usePageCovered, usePageTone, usePageVeiled } from "../../state/browse/hooks";
import { shownTone } from "../../lib/pageTone";
import { registerPageHandle } from "../../state/pages/store";
import { tabSavedState } from "../../state/tabs/store";
import { useCanReopen } from "../../state/tabs/hooks";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { usePreferences } from "../../state/settings/hooks";
import { pageSwipe } from "../../state/settings/settingsRules";
import { PageView, useTheme, type PageViewHandle } from "../ui";

export function PageSurface({ tab, toneBottom, obscured, summaryBottomInset, topClearance, pinsSafeArea, testID }: { tab: BrowserTab; toneBottom: number; obscured?: { top: number; bottom: number }; summaryBottomInset?: number; topClearance?: number; pinsSafeArea?: boolean; testID?: string }) {
  const handle = useRef<PageViewHandle>(null);
  const theme = useTheme();
  const id = tab.id;
  const swipe = usePreferences((p) => p.swipeNavigation);
  const canReopen = useCanReopen();
  const veiled = usePageVeiled(id);
  const covered = usePageCovered(id);
  const arriving = usePageArriving(id);
  const tone = usePageTone(id);
  const failed = useNavigation(id, (n) => n?.failure != null);
  const pageTone = failed ? null : shownTone(tone, tab.themeColorHex);
  const obscuredColors = obscured ? { top: pageTone?.top ?? theme.canvas, bottom: pageTone?.bottom ?? theme.canvas } : undefined;
  const [setup] = useState(() => ({ url: tab.url, title: tab.title, saved: tabSavedState(id) ?? undefined }));
  useEffect(() => {
    registerPageHandle(id, handle.current);
    return () => registerPageHandle(id, null);
  }, [id]);
  return (
    <PageView
      ref={handle}
      testID={testID}
      style={veiled ? [StyleSheet.absoluteFill, styles.veiled] : StyleSheet.absoluteFill}
      pageId={id}
      initialUrl={setup.url}
      title={setup.title}
      isPrivate={tab.isPrivate}
      savedState={setup.saved}
      toneInsets={{ top: 0, bottom: toneBottom }}
      obscuredInsets={obscured}
      summaryBottomInset={summaryBottomInset}
      obscuredColors={obscuredColors}
      topClearance={topClearance}
      pinsSafeArea={pinsSafeArea}
      swipeNavigation={pageSwipe(swipe)}
      closesOnSwipeBack
      reopensOnSwipeForward={canReopen}
      onSwipedPastHistory={(direction) => swipedPastHistory(id, direction)}
      pullToRefresh
      surfaceColor={theme.canvas}
      onPageState={(state) => pageStateChanged(id, state)}
      onPageTone={(tone) => pageToneChanged(id, tone)}
      onPageDrawn={() => pageDrawn(id)}
      onPageError={(error) => pageOpenFailed(id, error.code)}
      coverNativeId={covered ? (arriving ? ARRIVAL_COVER_ID : OPENING_COVER_ID) : undefined}
      onPageCoverHidden={(reason) => pageCoverHidden(id, reason)}
    />
  );
}

const styles = StyleSheet.create({ veiled: { opacity: 0 } });
