import { memo, useEffect, useState } from "react";
import { countRender } from "../../state/app/interactionPerf";
import { Platform, StyleSheet } from "react-native";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { PAGE_COVER, pageCoverNeeded } from "../../lib/pageCover";
import { usePageTone } from "../../state/browse/hooks";
import { useBrowse } from "../../state/browse/store";
import { holdTone, pageNavigation, releaseTone, usePages } from "../../state/pages/store";
import { display } from "../../state/search/omnibox";
import { launchArguments } from "../../state/app/launchFlags";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { TabFace, useTheme } from "../ui";
import { PageLoadingPlaceholder } from "./PageLoadingPlaceholder";

export const PageCover = memo(function PageCover({ tab }: { tab: BrowserTab }) {
  countRender("PageCover");
  const theme = useTheme();
  const tone = usePageTone(tab.id);
  const [frozen] = useState(() => launchArguments().loadFreeze !== null);
  const [needed] = useState(() => frozen || pageCoverNeeded(pageNavigation(tab.id), Boolean(tab.snapshotFileName)));
  const [gone, setGone] = useState(!needed);
  const opacity = useSharedValue(needed ? 1 : 0);
  useEffect(() => {
    if (!needed || frozen) return;
    holdTone(tab.id);
    return () => releaseTone(tab.id);
  }, []);
  useEffect(() => {
    if (!needed || frozen) return;
    let fading = false;
    let sawLoading = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const fade = () => {
      if (fading) return;
      fading = true;
      opacity.value = withTiming(0, { duration: PAGE_COVER.fadeMs }, (finished) => {
        if (finished) runOnJS(coverGone)(tab.id);
      });
    };
    const check = () => {
      if (fading) return;
      const shownAlone = useBrowse.getState().surface === "browsing";
      if (shownAlone && !deadline) deadline = setTimeout(fade, PAGE_COVER.deadlineMs);
      const page = pageNavigation(tab.id);
      if (!page?.isLive) return;
      if (page.isLoading) {
        sawLoading = true;
        if (settle) clearTimeout(settle);
        settle = null;
        return;
      }
      if (!shownAlone) return;
      if (sawLoading) {
        fade();
        return;
      }
      if (!settle) settle = setTimeout(fade, PAGE_COVER.settleMs);
    };
    check();
    const pages = usePages.subscribe(check);
    const browse = useBrowse.subscribe(check);
    return () => {
      pages();
      browse();
      if (deadline) clearTimeout(deadline);
      if (settle) clearTimeout(settle);
    };
  }, []);
  const coverGone = (id: string) => {
    releaseTone(id);
    setGone(true);
  };
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  if (gone) return null;
  const shown = display(tab.url);
  const picture = frozen ? null : tab.snapshotFileName;
  const spoken = !picture && Platform.OS === "ios";
  return (
    <Animated.View
      testID="pageCover"
      needsOffscreenAlphaCompositing
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden={!spoken}
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.surface }, style]}
    >
      {picture ? (
        <TabFace tab={tab} title={tab.title || shown.host} host={shown.host} tone={tone?.top ?? null} roles={theme} paintedAs={`cover:${tab.id}`} />
      ) : (
        <PageLoadingPlaceholder tab={tab} />
      )}
    </Animated.View>
  );
});
