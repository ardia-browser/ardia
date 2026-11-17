import { createContext, memo, useContext, useEffect, useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import { PixelRatio, Platform, StyleSheet, View } from "react-native";
import Animated, { makeMutable, startMapper, stopMapper, useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { countRender } from "../../state/app/interactionPerf";
import { isUnseenReceived } from "../../lib/tabFace";
import { DECK_HEADER, deckBarBand, deckHeaderIconReveal, deckHeaderLeading, deckHeaderPlacement, deckSlot, deckStatusStrip, titleReveal, type DeckGeometry, type DeckSlots } from "../../lib/deckGeometry";
import { useHeldPageTone } from "../../state/browse/deckHold";
import { display } from "../../state/search/omnibox";
import { shownTone } from "../../lib/pageTone";
import { snapshotPageTop } from "../../lib/shownSnapshots";
import { barHeight, FadeView, font, screenReaderActions, TabFace, tabsInk, tabsLayout, useDesign, usePageUnderBars, useTheme, isDarkColor } from "../ui";
import { nativeMenus } from "../ui/MenuTrigger";
import { isLabBuild } from "../../platform/lab";
import { launchArguments } from "../../state/app/launchFlags";
import { CardIcon, cardPose, deckHeaderTitle, DeckCard, DeckCardMenu, deckCardStyles, deckRole, EXPANDED_Z, ReceivedBadge, sameCard, type DeckMotion } from "./DeckCard";

export const containedDeckScroll = (): boolean => Platform.OS === "android" && isLabBuild && launchArguments().oneContainerScroll;

type CardMove = { x: number; y: number; scale: number };
type CardLook = { opacity: number; corner: number };
type ReachLook = { x: number; y: number; scaleX: number; scaleY: number };
type HeaderLook = { x: number; y: number; opacity: number };

export type ContainedPlacement = { z: number; move: CardMove; look: CardLook; reach: ReachLook; header: HeaderLook; available: number; expanded: boolean; stacked: boolean };

export type ContainedInputs = {
  ids: readonly string[];
  scroll: number;
  phase: number;
  expanded: number;
  scaleProgress: number;
  positionProgress: number;
  dragIndex: number;
  dragLift: number;
  flyIndex: number;
  flyLift: number;
  flyVanish: number;
  covering: string;
  fromSlots: DeckSlots;
  shiftBy: number;
  gap: number;
};

export type DeviceGrid = { ratio: number; spacing: number; focus: number };

type CardFeed = {
  z: SharedValue<number>;
  move: SharedValue<CardMove>;
  look: SharedValue<CardLook>;
  reach: SharedValue<ReachLook>;
  header: SharedValue<HeaderLook>;
  available: SharedValue<number>;
  expanded: SharedValue<boolean>;
  gone: SharedValue<boolean>;
};

type Feeds = Record<string, CardFeed>;

const STACK_DEPTH = -2.5;

export const deviceGrid = (g: DeckGeometry, ratio: number): DeviceGrid => ({ ratio, spacing: Math.round(g.spacing * ratio), focus: Math.round(g.focusLeading * ratio) });

export const gridGeometry = (g: DeckGeometry, grid: DeviceGrid): DeckGeometry => ({ ...g, spacing: grid.spacing / grid.ratio, focusLeading: grid.focus / grid.ratio });

export function devicePixel(value: number, ratio: number): number {
  "worklet";
  return Math.round(value * ratio) / ratio;
}

export function opacityStep(value: number): number {
  "worklet";
  return Math.round(value * 255) / 255;
}

export function containedOffsetPx(grid: DeviceGrid, scroll: number): number {
  "worklet";
  return Math.round(-grid.spacing * scroll);
}

export function containedPlacement(g: DeckGeometry, grid: DeviceGrid, now: ContainedInputs, index: number, gone: boolean, id: string): ContainedPlacement {
  "worklet";
  const ratio = grid.ratio;
  const listed = index >= 0;
  const role = deckRole(now.phase, now.expanded, index);
  const flying = listed && now.flyIndex === index;
  const lift = listed && now.dragIndex === index ? now.dragLift : flying ? now.flyLift : 0;
  const slotAt = listed ? deckSlot(id, index, now.fromSlots, now.shiftBy, now.gap) : 0;
  const relative = slotAt - now.scroll;
  const p = cardPose(g, role, relative, now.scaleProgress, now.positionProgress, lift, flying ? now.flyVanish : gone || !listed ? 1 : 0, index === now.ids.length - 1);
  const exact = role !== "stay";
  const fit = (value: number) => (exact ? value : devicePixel(value, ratio));
  const shade = (value: number) => (exact ? value : opacityStep(value));
  const offsetPx = containedOffsetPx(grid, now.scroll);
  const left = p.x - g.cardWidth / 2;
  const xPx = exact ? left * ratio - offsetPx : relative >= 0 && Math.floor(slotAt) === slotAt ? grid.focus + grid.spacing * slotAt : Math.round(left * ratio) - offsetPx;
  const x = xPx / ratio;
  const cardLeft = p.x - (g.cardWidth * p.scale) / 2;
  const top = p.y - (g.cardHeight * p.scale) / 2;
  const place = deckHeaderPlacement(cardLeft, p.visible);
  const available = fit(place.available);
  return {
    z: Math.max(index, 0) * 2 + (role === "expanded" ? EXPANDED_Z : 0),
    move: { x, y: fit(p.y - g.cardHeight / 2), scale: p.scale },
    look: { opacity: now.covering === id ? 0 : shade(p.opacity), corner: p.corner / Math.max(p.scale, 0.01) },
    reach: { x: x + fit(cardLeft - left), y: fit(top), scaleX: Math.max(1, fit(p.visible * p.scale)) / g.cardWidth, scaleY: p.scale },
    header: { x: x + fit(place.left + place.available - g.cardWidth - left), y: fit(top - tabsLayout.headerGap - tabsLayout.headerHeight), opacity: shade(p.header * deckHeaderIconReveal(available, tabsLayout.faviconSize)) },
    available,
    expanded: role === "expanded",
    stacked: !exact && lift === 0 && !flying && relative <= STACK_DEPTH,
  };
}

function readInputs(motion: DeckMotion): ContainedInputs {
  return {
    ids: motion.orderIds.value,
    scroll: motion.scroll.value,
    phase: motion.phase.value,
    expanded: motion.expandedIndex.value,
    scaleProgress: motion.scaleProgress.value,
    positionProgress: motion.positionProgress.value,
    dragIndex: motion.dragIndex.value,
    dragLift: motion.dragLift.value,
    flyIndex: motion.flyIndex.value,
    flyLift: motion.flyLift.value,
    flyVanish: motion.flyVanish.value,
    covering: motion.covering.value,
    fromSlots: motion.fromSlots.value,
    shiftBy: motion.shiftBy.value,
    gap: motion.gap.value,
  };
}

function makeFeed(placed: ContainedPlacement): CardFeed {
  return {
    z: makeMutable(placed.z),
    move: makeMutable(placed.move),
    look: makeMutable(placed.look),
    reach: makeMutable(placed.reach),
    header: makeMutable(placed.header),
    available: makeMutable(placed.available),
    expanded: makeMutable(placed.expanded),
    gone: makeMutable(false),
  };
}

const FeedsContext = createContext<Feeds>({});

type ContainedCardsProps = { ids: readonly string[]; geometry: DeckGeometry; motion: DeckMotion; children: ReactNode };

export function containedCards(on: boolean, props: Omit<ContainedCardsProps, "children">, cards: ReactNode): ReactNode {
  return on ? <ContainedCards {...props}>{cards}</ContainedCards> : cards;
}

function ContainedCards({ ids, geometry, motion, children }: ContainedCardsProps) {
  const ratio = PixelRatio.get();
  const grid = useMemo(() => deviceGrid(geometry, ratio), [geometry, ratio]);
  const g = useMemo(() => gridGeometry(geometry, grid), [geometry, grid]);
  const made = useRef<Map<string, CardFeed>>(new Map());
  const feeds = useMemo(() => {
    const now = readInputs(motion);
    const at = new Map(now.ids.map((id, index) => [id, index]));
    const next: Feeds = {};
    for (const id of ids) next[id] = made.current.get(id) ?? makeFeed(containedPlacement(g, grid, now, at.get(id) ?? -1, false, id));
    made.current = new Map(Object.entries(next));
    return next;
  }, [ids]);
  const offset = useSharedValue(containedOffsetPx(grid, motion.scroll.value) / ratio);
  const { orderIds, scroll, phase, expandedIndex, scaleProgress, positionProgress, dragIndex, dragLift, flyIndex, flyLift, flyVanish, covering, fromSlots, shiftBy, gap } = motion;
  useEffect(() => {
    const cardIds = Object.keys(feeds);
    const place = () => {
      "worklet";
      const now: ContainedInputs = {
        ids: orderIds.value,
        scroll: scroll.value,
        phase: phase.value,
        expanded: expandedIndex.value,
        scaleProgress: scaleProgress.value,
        positionProgress: positionProgress.value,
        dragIndex: dragIndex.value,
        dragLift: dragLift.value,
        flyIndex: flyIndex.value,
        flyLift: flyLift.value,
        flyVanish: flyVanish.value,
        covering: covering.value,
        fromSlots: fromSlots.value,
        shiftBy: shiftBy.value,
        gap: gap.value,
      };
      const nextOffset = containedOffsetPx(grid, now.scroll) / grid.ratio;
      if (offset.value !== nextOffset) offset.value = nextOffset;
      const atRest = Math.floor(now.scroll) === now.scroll;
      const at: Record<string, number> = {};
      for (let i = 0; i < now.ids.length; i++) at[now.ids[i]!] = i;
      for (let c = 0; c < cardIds.length; c++) {
        const id = cardIds[c]!;
        const feed = feeds[id]!;
        const index = at[id] ?? -1;
        if (index >= 0 && now.flyIndex === index && now.flyVanish >= 1 && !feed.gone.value) feed.gone.value = true;
        const next = containedPlacement(g, grid, now, index, feed.gone.value, id);
        if (feed.z.value !== next.z) feed.z.value = next.z;
        const move = feed.move.value;
        if (move.x !== next.move.x || move.y !== next.move.y || move.scale !== next.move.scale) feed.move.value = next.move;
        const look = feed.look.value;
        if (look.opacity !== next.look.opacity || look.corner !== next.look.corner) feed.look.value = next.look;
        const reach = feed.reach.value;
        if ((!next.stacked || atRest) && (reach.x !== next.reach.x || reach.y !== next.reach.y || reach.scaleX !== next.reach.scaleX || reach.scaleY !== next.reach.scaleY)) feed.reach.value = next.reach;
        const header = feed.header.value;
        if ((header.opacity !== 0 || next.header.opacity !== 0) && (header.x !== next.header.x || header.y !== next.header.y || header.opacity !== next.header.opacity)) feed.header.value = next.header;
        if (feed.available.value !== next.available) feed.available.value = next.available;
        if (feed.expanded.value !== next.expanded) feed.expanded.value = next.expanded;
      }
    };
    const outputs = [offset, ...cardIds.flatMap((id) => Object.values(feeds[id]!))] as unknown as Parameters<typeof startMapper>[2];
    const mapper = startMapper(place, [orderIds, scroll, phase, expandedIndex, scaleProgress, positionProgress, dragIndex, dragLift, flyIndex, flyLift, flyVanish, covering, fromSlots, shiftBy, gap], outputs);
    return () => stopMapper(mapper);
  }, [feeds, g, grid]);
  const containerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  return (
    <Animated.View testID="deckScrollContainer" pointerEvents="box-none" collapsable={false} style={[styles.container, { width: geometry.width + geometry.spacing * Math.max(ids.length, 1) + geometry.cardWidth, height: geometry.height }, containerStyle]}>
      <FeedsContext.Provider value={feeds}>{children}</FeedsContext.Provider>
    </Animated.View>
  );
}

export const ContainedDeckCard = memo(function ContainedDeckCard({ tab, index, geometry: g, motion, onOpen, onClose, onCloseNow }: ComponentProps<typeof DeckCard>) {
  countRender("DeckCard");
  const theme = useTheme();
  const design = useDesign();
  const tone = shownTone(useHeldPageTone(tab.id), tab.themeColorHex);
  const { z, move, look, reach, header, available, expanded } = useContext(FeedsContext)[tab.id]!;
  const { scaleProgress } = motion;
  const ratio = PixelRatio.get();
  const cardZ = useAnimatedStyle(() => ({ zIndex: z.value }));
  const overZ = useAnimatedStyle(() => ({ zIndex: z.value + 1 }));
  const moveStyle = useAnimatedStyle(() => {
    const m = move.value;
    return { transform: [{ translateX: m.x }, { translateY: m.y }, { scale: m.scale }] };
  });
  const lookStyle = useAnimatedStyle(() => {
    const l = look.value;
    return { opacity: l.opacity, borderRadius: l.corner };
  });
  const reachStyle = useAnimatedStyle(() => {
    const r = reach.value;
    return { transform: [{ translateX: r.x }, { translateY: r.y }, { scaleX: r.scaleX }, { scaleY: r.scaleY }] };
  });
  const headerStyle = useAnimatedStyle(() => {
    const h = header.value;
    return { opacity: h.opacity, transform: [{ translateX: h.x }, { translateY: h.y }] };
  });
  const titleWidth = useSharedValue(0);
  const rowStyle = useAnimatedStyle(() => {
    const room = available.value;
    return { transform: [{ translateX: devicePixel(g.cardWidth - room + deckHeaderLeading(room, tabsLayout.faviconSize, tabsLayout.headerSpacing, titleWidth.value, titleReveal(room)), ratio) }] };
  }, [g, ratio]);
  const titleStyle = useAnimatedStyle(() => ({ opacity: opacityStep(titleReveal(available.value)) }));
  const underBars = usePageUnderBars();
  const pageTop = (tab.snapshotFileName ? snapshotPageTop(tab.snapshotFileName) : null) ?? (underBars ? 0 : g.safeTop);
  const faceStyle = useAnimatedStyle(() => ({ transform: [{ translateY: expanded.value ? deckStatusStrip(g, scaleProgress.value, pageTop) : 0 }] }), [g, pageTop]);
  const bar = deckBarBand(g, barHeight(g.safeBottom), 1);
  const bandStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: expanded.value && !underBars ? deckBarBand(g, 0, scaleProgress.value).grown : 0 }] }), [g, underBars]);

  const host = display(tab.url).host;
  const title = tab.title || host || "New Tab";
  const cardContents = (
    <>
      <Animated.View testID="deckCardFace" style={[StyleSheet.absoluteFill, faceStyle]}>
        <TabFace tab={tab} title={title} host={host} tone={tone.top} roles={theme} paintedAs={`deck:${tab.id}`} />
      </Animated.View>
      <Animated.View testID="deckCardBarBand" pointerEvents="none" style={[deckCardStyles.band, { height: bar.height, backgroundColor: tone.bottom ?? theme.surface }, bandStyle]}>
        {design === "original" ? <View testID="deckCardBarShade" style={[StyleSheet.absoluteFill, { backgroundColor: isDarkColor(tone.bottom ?? theme.surface) ? tabsInk.barShadeOnDark : tabsInk.barShadeOnLight }]} /> : null}
      </Animated.View>
      {isUnseenReceived(tab) ? <ReceivedBadge /> : null}
    </>
  );
  return (
    <>
      <Animated.View
        testID="deckCard"
        needsOffscreenAlphaCompositing
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[deckCardStyles.card, { width: g.cardWidth, height: g.cardHeight, borderColor: theme.cardEdge, backgroundColor: tone.top ?? theme.surface }, cardZ, lookStyle, moveStyle]}
      >
        {nativeMenus() ? (
          <DeckCardMenu tab={tab} index={index} onClose={onClose} fill={tone.top ?? theme.surface}>
            {cardContents}
          </DeckCardMenu>
        ) : (
          cardContents
        )}
      </Animated.View>
      <Animated.View
        testID="deckCardReach"
        accessible
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityValue={{ text: tab.isPrivate ? `Incognito, ${host}` : host }}
        accessibilityHint="Opens the tab."
        {...screenReaderActions([
          { name: "activate", run: () => onOpen(index) },
          { name: "close", label: "Close Tab", run: () => onCloseNow(index) },
        ])}
        pointerEvents="none"
        style={[deckCardStyles.reach, { width: g.cardWidth, height: g.cardHeight }, overZ, reachStyle]}
      />
      <Animated.View testID="deckCardHeader" style={[deckCardStyles.header, { width: g.cardWidth }, overZ, headerStyle]} pointerEvents="none">
        <FadeView testID="deckHeaderFade" trailing={{ length: DECK_HEADER.trailingFade }} style={StyleSheet.absoluteFill}>
          <Animated.View style={[deckCardStyles.headerRow, rowStyle]}>
            <CardIcon tab={tab} />
            <Animated.Text
              testID="deckHeaderTitle"
              maxFontSizeMultiplier={DECK_HEADER.maxFontScale}
              onLayout={(event) => {
                titleWidth.value = event.nativeEvent.layout.width;
              }}
              style={[font.caption, deckCardStyles.title, { color: theme.headerText }, titleStyle]}
              numberOfLines={1}
            >
              {deckHeaderTitle(tab, title)}
            </Animated.Text>
          </Animated.View>
        </FadeView>
      </Animated.View>
    </>
  );
}, sameCard);

const styles = StyleSheet.create({
  container: { position: "absolute", left: 0, top: 0 },
});
