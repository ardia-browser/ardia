import { memo, useEffect, useState, type ReactNode } from "react";
import { countRender } from "../../state/app/interactionPerf";
import { Platform, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { PAGE_COVER, pageAtRest, pageCoverNeeded } from "../../lib/pageCover";
import { usePageTone } from "../../state/browse/hooks";
import { arrivalCovers, documentWasDrawn, listenForPageDrawn, useBrowse } from "../../state/browse/store";
import { holdTone, pageNavigation, releaseTone, usePages } from "../../state/pages/store";
import { display } from "../../state/search/omnibox";
import { launchArguments } from "../../state/app/launchFlags";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { currentTabs } from "../../state/tabs/store";
import { findTab } from "../../state/tabs/tabsState";
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

const WAITS_FOR_PAINT = Platform.OS === "ios";

const COVER_TOUCHES = WAITS_FOR_PAINT ? ("auto" as const) : ("none" as const);

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
  const [picture] = useState(() => findTab(currentTabs(), tab.id)?.snapshotFileName ?? tab.snapshotFileName);
  const [needed] = useState(() => frozen || pageCoverNeeded(pageNavigation(tab.id), Boolean(picture) && (WAITS_FOR_PAINT || !arrivalCovers(tab.id))));
  const [atRest] = useState(() => pageAtRest(pageNavigation(tab.id)));
  const [face] = useState(() => coverFace(tab, frozen ? null : picture, openingCardOf(tab.id)));
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
    let paintDeadline: ReturnType<typeof setTimeout> | null = null;
    let paintDeadlineFor: string | null = null;
    const fade = () => {
      if (fading) return;
      fading = true;
      opacity.value = withTiming(0, { duration: PAGE_COVER.fadeMs }, (finished) => {
        if (finished) runOnJS(coverGone)(tab.id);
      });
    };
    const cut = () => {
      if (fading) return;
      fading = true;
      opacity.value = 0;
      coverGone(tab.id);
    };
    const stopPaintDeadline = () => {
      if (paintDeadline) clearTimeout(paintDeadline);
      paintDeadline = null;
      paintDeadlineFor = null;
    };
    const stopSettle = () => {
      if (settle) clearTimeout(settle);
      settle = null;
    };
    const shownAloneNow = () => useBrowse.getState().surface === "browsing";
    const fadeIfShownAlone = () => {
      if (shownAloneNow()) fade();
    };
    const check = () => {
      if (fading) return;
      const shownAlone = useBrowse.getState().surface === "browsing";
      if (shownAlone && !deadline) deadline = setTimeout(fade, PAGE_COVER.deadlineMs);
      const page = pageNavigation(tab.id);
      if (!page?.isLive) return;
      if (WAITS_FOR_PAINT && shownAlone && documentWasDrawn(tab.id)) {
        if (atRest && !sawLoading) cut();
        else fade();
        return;
      }
      if (page.isLoading) {
        stopPaintDeadline();
        sawLoading = true;
        stopSettle();
        return;
      }
      if (!shownAlone) {
        stopPaintDeadline();
        stopSettle();
        return;
      }
      if (WAITS_FOR_PAINT) {
        const shownDocument = `${page.document ?? ""}:${page.url ?? ""}`;
        if (paintDeadlineFor !== shownDocument) {
          stopPaintDeadline();
          paintDeadlineFor = shownDocument;
          paintDeadline = setTimeout(() => {
            paintDeadline = null;
            paintDeadlineFor = null;
            fadeIfShownAlone();
          }, PAGE_COVER.paintDeadlineMs);
        }
        return;
      }
      if (sawLoading) {
        fade();
        return;
      }
      if (!settle)
        settle = setTimeout(() => {
          settle = null;
          fadeIfShownAlone();
        }, PAGE_COVER.settleMs);
    };
    const stopDrawn = WAITS_FOR_PAINT ? listenForPageDrawn(tab.id, check) : null;
    check();
    const pages = usePages.subscribe(check);
    const browse = useBrowse.subscribe(check);
    return () => {
      pages();
      browse();
      stopDrawn?.();
      if (deadline) clearTimeout(deadline);
      stopSettle();
      stopPaintDeadline();
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
      pointerEvents={COVER_TOUCHES}
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
