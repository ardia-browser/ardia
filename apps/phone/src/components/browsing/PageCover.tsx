import { memo, useEffect, useState, type ReactNode } from "react";
import { countRender } from "../../state/app/interactionPerf";
import { Dimensions, Image, Platform, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import Animated, { runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { PAGE_COVER, pageAtRest, pageCoverNeeded } from "../../lib/pageCover";
import { usePageTone } from "../../state/browse/hooks";
import { arrivalCovers, documentWasDrawn, takeCutCardWidth, listenForPageDrawn, useBrowse } from "../../state/browse/store";
import { holdTone, pageNavigation, releaseTone, usePages } from "../../state/pages/store";
import { display } from "../../state/search/omnibox";
import { launchArguments } from "../../state/app/launchFlags";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { currentTabs } from "../../state/tabs/store";
import { findTab } from "../../state/tabs/tabsState";
import { noteWarmDecoded, useWarmPicture, warmDecoded } from "../../state/tabs/warmPictures";
import { TabFace, useTheme } from "../ui";
import { tabSwitchCuts } from "../../state/browse/tabSwitch";
import { pageReportsDrawn } from "@ardia/phone-native";
import { PageLoadingPlaceholder } from "./PageLoadingPlaceholder";
import { pageWords } from "../../lib/sharedWords";
import { destination, destinationCovers, destinationFaceShows } from "../../state/browse/destination";
import { pageBarShown } from "../../state/browse/deckPull";
import { UiFrameMark, uiFrameMarkStyle } from "../ui/UiFrameMark";

export type CoverFace = { kind: "card"; picture: string | null; title: string; host: string; cardWidth: number | null } | { kind: "placeholder" };

export type OpeningCard = { cardWidth: number | null };

export function coverFace(tab: Pick<BrowserTab, "title" | "url">, picture: string | null, card: OpeningCard | null, identified = false): CoverFace {
  if (!picture && !card && !identified) return { kind: "placeholder" };
  const host = display(tab.url).host;
  return { kind: "card", picture, title: tab.title || host || pageWords.untitledTab, host, cardWidth: card?.cardWidth ?? null };
}

const openingCardOf = (id: string): OpeningCard | null => {
  const { opening, openingCardWidth } = useBrowse.getState();
  if (opening === id) return { cardWidth: openingCardWidth };
  const cut = takeCutCardWidth(id);
  return cut === null ? null : { cardWidth: cut };
};

type Box = { width: number; height: number };

const WAITS_FOR_PAINT = Platform.OS === "ios";


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
  const [needed] = useState(() => frozen || (!destinationCovers(tab.id) && pageCoverNeeded(pageNavigation(tab.id), Boolean(picture) && (WAITS_FOR_PAINT || !arrivalCovers(tab.id)))));
  const [atRest] = useState(() => pageAtRest(pageNavigation(tab.id)));
  const [cutsOnDraw] = useState(() => !WAITS_FOR_PAINT && tabSwitchCuts() && pageReportsDrawn());
  const waitsForPaint = WAITS_FOR_PAINT || cutsOnDraw;
  const [face] = useState(() => coverFace(tab, frozen ? null : picture, openingCardOf(tab.id), cutsOnDraw));
  const warm = useWarmPicture(findTab(currentTabs(), tab.id) ?? tab, Dimensions.get("window"), cutsOnDraw && face.kind === "card");
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
      if (!shownAloneNow()) return;
      if (cutsOnDraw) cut();
      else fade();
    };
    const check = () => {
      if (fading) return;
      const shownAlone = useBrowse.getState().surface === "browsing";
      if (shownAlone && !deadline && !cutsOnDraw) deadline = setTimeout(fade, PAGE_COVER.deadlineMs);
      const page = pageNavigation(tab.id);
      if (!page?.isLive) return;
      if (waitsForPaint && shownAlone && documentWasDrawn(tab.id) && !(cutsOnDraw && page.isLoading)) {
        if (cutsOnDraw || (atRest && !sawLoading)) cut();
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
      if (waitsForPaint) {
        const shownDocument = `${page.document ?? ""}:${page.url ?? ""}`;
        if (paintDeadlineFor !== shownDocument) {
          stopPaintDeadline();
          paintDeadlineFor = shownDocument;
          paintDeadline = setTimeout(() => {
            paintDeadline = null;
            paintDeadlineFor = null;
            if (cutsOnDraw) return;
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
    const stopDrawn = waitsForPaint ? listenForPageDrawn(tab.id, check) : null;
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
      pointerEvents={waitsForPaint && !warm ? "auto" : "none"}
      collapsable={false}
      importantForAccessibility={"no-hide-descendants"}
      accessibilityElementsHidden={!spoken}
      onLayout={face.kind === "card" && face.cardWidth ? laidOut : undefined}
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.canvas }, style]}
    >
      {warm ? (
        <Image testID="pageCoverWarmPicture" source={{ uri: warm.uri }} fadeDuration={0} style={[styles.warm, { left: warm.frame.x, top: warm.frame.y, width: warm.frame.width, height: warm.frame.height }]} />
      ) : face.kind === "card" ? (
        <AtCardScale cardWidth={face.cardWidth} box={box}>
          <TabFace tab={{ ...tab, snapshotFileName: cutsOnDraw ? null : face.picture }} title={face.title} host={face.host} tone={tone?.top ?? null} roles={theme} paintedAs={`cover:${tab.id}`} />
        </AtCardScale>
      ) : (
        <PageLoadingPlaceholder tab={tab} />
      )}
    </Animated.View>
  );
});

type DestinationFaceProps = { tab: BrowserTab; cover: string | undefined; statusHeight: number; statusOver: boolean };

export const DestinationFace = memo(function DestinationFace({ tab, cover, statusHeight, statusOver }: DestinationFaceProps) {
  const theme = useTheme();
  const tone = usePageTone(tab.id);
  const viewport = useWindowDimensions();
  const warm = useWarmPicture(tab, viewport, true);
  const [decoded, setDecoded] = useState<string | null>(() => (warm && warmDecoded(tab.id, warm.uri) ? warm.uri : null));
  const shown = display(tab.url);
  const id = tab.id;
  const face = useAnimatedStyle(() => {
    const lifted = destination.id.value;
    const bar = pageBarShown.value;
    return { opacity: destinationFaceShows(id, lifted, bar) ? 1 : 0 };
  }, [id]);
  const faceMark = useAnimatedStyle(() => {
    const lifted = destination.id.value;
    const bar = pageBarShown.value;
    return { opacity: destinationFaceShows(id, lifted, bar) ? 1 : 0 };
  }, [id]);
  const barMark = useAnimatedStyle(() => {
    const lifted = destination.id.value;
    const bar = pageBarShown.value;
    return { opacity: destinationFaceShows(id, lifted, bar) ? 1 : 0 };
  }, [id]);
  const touches = useAnimatedProps<{ pointerEvents: "auto" | "none" }>(() => {
    const lifted = destination.id.value;
    const bar = pageBarShown.value;
    return { pointerEvents: destinationFaceShows(id, lifted, bar) ? "auto" : "none" };
  }, [id]);
  const pictured = warm !== null && (decoded === warm.uri || warmDecoded(id, warm.uri));
  const pictureDecoded = (uri: string) => {
    noteWarmDecoded(id, uri);
    setDecoded(uri);
  };
  return (
    <Animated.View testID="destinationFace" nativeID={cover} collapsable={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[StyleSheet.absoluteFill, { backgroundColor: theme.canvas }, face]} animatedProps={touches}>
      {statusOver ? null : <View style={{ height: statusHeight, backgroundColor: tone?.top ?? theme.canvas }} />}
      <View testID="destinationTitle" style={styles.body}>
        <TabFace tab={{ ...tab, snapshotFileName: null }} title={tab.title || shown.host} host={shown.host} tone={tone?.top ?? null} roles={theme} paintedAs={`destination:${tab.id}`} />
      </View>
      {warm ? <Image testID="destinationPicture" source={{ uri: warm.uri }} resizeMethod="scale" fadeDuration={0} onLoad={() => pictureDecoded(warm.uri)} style={[styles.warm, { left: warm.frame.x, top: warm.frame.y, width: warm.frame.width, height: warm.frame.height, opacity: pictured ? 1 : 0 }]} /> : null}
      {statusOver ? <View style={[styles.statusOver, { height: statusHeight, backgroundColor: tone?.top ?? theme.pageSurface }]} /> : null}
      <UiFrameMark testID="destinationFaceMark" style={[uiFrameMarkStyle, faceMark]} markWhenShown={`dest-face:${id}`} />
      <UiFrameMark testID="destinationBarMark" style={[uiFrameMarkStyle, barMark]} markWhenShown={`dest-bar:${id}`} />
    </Animated.View>
  );
});

const styles = StyleSheet.create({ body: { flex: 1 }, statusOver: { position: "absolute", left: 0, right: 0, top: 0 }, cardFace: { position: "absolute", left: 0, top: 0, transformOrigin: "left top" }, warm: { position: "absolute" } });
