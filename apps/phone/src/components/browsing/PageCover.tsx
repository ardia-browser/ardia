import { memo, useEffect, useState, type ReactNode } from "react";
import { countRender } from "../../state/app/interactionPerf";
import { Platform, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { PAGE_COVER, pageCoverNeeded } from "../../lib/pageCover";
import { usePageTone } from "../../state/browse/hooks";
import { arrivalCovers, useBrowse } from "../../state/browse/store";
import { holdTone, pageNavigation, releaseTone, usePages } from "../../state/pages/store";
import { display } from "../../state/search/omnibox";
import { launchArguments } from "../../state/app/launchFlags";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { TabFace, useTheme } from "../ui";
import { PageLoadingPlaceholder } from "./PageLoadingPlaceholder";
import { pageWords } from "../../lib/sharedWords";

export type CoverFace = { kind: "card"; picture: string | null; title: string; host: string; cardWidth: number | null } | { kind: "placeholder" };

export type OpeningCard = { cardWidth: number | null };

export function coverFace(tab: Pick<BrowserTab, "title" | "url">, picture: string | null, card: OpeningCard | null): CoverFace {
  if (!picture && !card) return { kind: "placeholder" };
  const host = display(tab.url).host;
  return { kind: "card", picture, title: tab.title || host || pageWords.untitledTab, host, cardWidth: card?.cardWidth ?? null };
}

const openingCardOf = (id: string): OpeningCard | null => {
  const { opening, openingCardWidth } = useBrowse.getState();
  return opening === id ? { cardWidth: openingCardWidth } : null;
};

type Box = { width: number; height: number };

function AtCardScale({ cardWidth, box, children }: { cardWidth: number | null; box: Box; children: ReactNode }) {
  if (!cardWidth || box.width <= 0 || box.height <= 0) return children;
  const scale = box.width / cardWidth;
  return <View testID="pageCoverCardFace" style={[styles.cardFace, { width: cardWidth, height: box.height / scale, transform: [{ scale }] }]}>{children}</View>;
}

export const PageCover = memo(function PageCover({ tab }: { tab: BrowserTab }) {
  countRender("PageCover");
  const theme = useTheme();
  const tone = usePageTone(tab.id);
  const [frozen] = useState(() => launchArguments().loadFreeze !== null);
  const [needed] = useState(() => frozen || pageCoverNeeded(pageNavigation(tab.id), Boolean(tab.snapshotFileName) && !arrivalCovers(tab.id)));
  const [face] = useState(() => coverFace(tab, frozen ? null : tab.snapshotFileName, openingCardOf(tab.id)));
  const window = useWindowDimensions();
  const [box, setBox] = useState<Box>(() => ({ width: window.width, height: window.height }));
  const laidOut = ({ nativeEvent: { layout } }: LayoutChangeEvent) => setBox((was) => (was.width === layout.width && was.height === layout.height ? was : { width: layout.width, height: layout.height }));
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
  const spoken = face.kind === "placeholder" && Platform.OS === "ios";
  return (
    <Animated.View
      testID="pageCover"
      needsOffscreenAlphaCompositing
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden={!spoken}
      onLayout={face.kind === "card" && face.cardWidth ? laidOut : undefined}
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.canvas }, style]}
    >
      {face.kind === "card" ? (
        <AtCardScale cardWidth={face.cardWidth} box={box}>
          <TabFace tab={{ ...tab, snapshotFileName: face.picture }} title={face.title} host={face.host} tone={tone?.top ?? null} roles={theme} paintedAs={`cover:${tab.id}`} />
        </AtCardScale>
      ) : (
        <PageLoadingPlaceholder tab={tab} />
      )}
    </Animated.View>
  );
});

const styles = StyleSheet.create({ cardFace: { position: "absolute", left: 0, top: 0, transformOrigin: "left top" } });
