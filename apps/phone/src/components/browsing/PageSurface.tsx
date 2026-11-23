import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { ARRIVAL_COVER_ID, notePageHosted, OPENING_COVER_ID, pageCoverHidden, pageDrawn, pageOpenFailed, pageStateChanged, pageToneChanged, swipedPastHistory } from "../../state/browse/store";
import { useArrivalCover, useNavigation, useOpeningCover, usePageArriving, usePageCovered, usePageTone, usePageVeiled } from "../../state/browse/hooks";
import { shownTone } from "../../lib/pageTone";
import { registerPageHandle, type PageState, type PageTone } from "../../state/pages/store";
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
  const arrivalCover = useArrivalCover();
  const openingCover = useOpeningCover();
  const tone = usePageTone(id);
  const failed = useNavigation(id, (n) => n?.failure != null);
  const pageTone = failed ? null : shownTone(tone, tab.themeColorHex);
  const colorTop = pageTone?.top ?? theme.canvas;
  const colorBottom = pageTone?.bottom ?? theme.canvas;
  const covers = obscured !== undefined;
  const obscuredColors = useMemo(() => (covers ? { top: colorTop, bottom: colorBottom } : undefined), [covers, colorTop, colorBottom]);
  const obscuredTop = obscured?.top;
  const obscuredBottom = obscured?.bottom;
  const obscuredInsets = useMemo(() => (obscuredTop === undefined || obscuredBottom === undefined ? undefined : { top: obscuredTop, bottom: obscuredBottom }), [obscuredTop, obscuredBottom]);
  const toneInsets = useMemo(() => ({ top: 0, bottom: toneBottom }), [toneBottom]);
  const onSwipedPastHistory = useCallback((direction: "back" | "forward") => swipedPastHistory(id, direction), [id]);
  const onPageState = useCallback((state: PageState) => pageStateChanged(id, state), [id]);
  const onPageTone = useCallback((next: PageTone) => pageToneChanged(id, next), [id]);
  const onPageDrawn = useCallback((document?: number) => pageDrawn(id, document), [id]);
  const onPageError = useCallback((error: { code: string }) => pageOpenFailed(id, error.code), [id]);
  const onPageCoverHidden = useCallback((reason: "drawn" | "cap", found: boolean, cover?: string) => pageCoverHidden(id, reason, cover, found), [id]);
  const [setup] = useState(() => ({ url: tab.url, title: tab.title, saved: tabSavedState(id) ?? undefined }));
  useLayoutEffect(() => notePageHosted(id), [id]);
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
      toneInsets={toneInsets}
      obscuredInsets={obscuredInsets}
      summaryBottomInset={summaryBottomInset}
      obscuredColors={obscuredColors}
      topClearance={topClearance}
      pinsSafeArea={pinsSafeArea}
      swipeNavigation={pageSwipe(swipe)}
      closesOnSwipeBack
      reopensOnSwipeForward={canReopen}
      onSwipedPastHistory={onSwipedPastHistory}
      pullToRefresh
      surfaceColor={theme.canvas}
      onPageState={onPageState}
      onPageTone={onPageTone}
      onPageDrawn={onPageDrawn}
      onPageError={onPageError}
      coverNativeId={covered ? (arriving ? (arrivalCover ?? ARRIVAL_COVER_ID) : (openingCover ?? OPENING_COVER_ID)) : undefined}
      onPageCoverHidden={onPageCoverHidden}
    />
  );
}

const styles = StyleSheet.create({ veiled: { opacity: 0 } });
