import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { countRender } from "../../state/app/interactionPerf";
import { PixelRatio, Platform, StyleSheet, Text, View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useDerivedValue, useSharedValue, type SharedValue } from "react-native-reanimated";
import { isUnseenReceived } from "../../lib/tabFace";
import { DECK, DECK_HEADER, deckBarBand, deckFlyLift, deckHeaderIconReveal, deckLeaveFade, deckStatusStrip, deckHeaderLeading, deckHeaderPlacement, deckLeading, deckSlot, deckVisibleWidth, lerp, titleReveal, type DeckGeometry, type DeckLeaving, type DeckSlots } from "../../lib/deckGeometry";
import { pullTuck } from "../../lib/deckPull";
import { useHeldPageTone } from "../../state/browse/deckHold";
import { display } from "../../state/search/omnibox";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { shownTone } from "../../lib/pageTone";
import { snapshotPageTop } from "../../lib/shownSnapshots";
import { barHeight, FadeView, Favicon, font, iPhoneOr, motionReportsNearEnd, MotionView, screenReaderActions, space, Symbol, IncognitoSpecs, TabFace, tabsInk, tabsLayout, tabsMotion, useDesign, usePageUnderBars, useTheme, isDarkColor, type MenuItem, type MotionCurve } from "../ui";
import { MenuTrigger, nativeMenus, spaceSystemImage, type MenuHandlers } from "../ui/MenuTrigger";
import { hideArchiveCard } from "../../state/browse/archiveCard";
import { OPENING_COVER_ID } from "../../state/browse/store";
import { canShareTab, copyTabLink, shareTab } from "../../state/browse/tabMenus";
import { openSettings } from "../../state/settings/nav";
import { useIsPinned, useSendTargets, useSyncEnabled, useSyncView } from "../../state/sync/hooks";
import { pinToMac, sendTab, type sendTargetsFor } from "../../state/sync/actions";
import { useTabSpaces } from "../../state/tabs/hooks";
import { moveTargets } from "../../state/tabs/spaces";
import { moveTabToSpace } from "../../state/tabs/store";
import type { SyncedProfile } from "../../state/sync/store";
import { isLabBuild } from "../../platform/lab";
import { launchArguments } from "../../state/app/launchFlags";

export type DeckRole = "stay" | "expanded" | "launcher" | "slideLeft" | "slideRight";

const UNSHOWN_TAB_FIELDS = new Set<keyof BrowserTab>(["lastActive"]);

function sameCardTab(a: BrowserTab, b: BrowserTab): boolean {
  if (a === b) return true;
  for (const key of Object.keys(a) as (keyof BrowserTab)[]) if (!UNSHOWN_TAB_FIELDS.has(key) && a[key] !== b[key]) return false;
  return Object.keys(a).length === Object.keys(b).length;
}

export function sameCard(a: Props, b: Props): boolean {
  for (const key of Object.keys(a) as (keyof Props)[]) {
    if (key === "tab" ? !sameCardTab(a.tab, b.tab) : a[key] !== b[key]) return false;
  }
  return true;
}

export const DECK_PHASE = { settled: 0, opening: 1, closing: 2, pulling: 3 } as const;

export function deckRole(phase: number, expanded: number, index: number): DeckRole {
  "worklet";
  if (phase === DECK_PHASE.settled || expanded < 0) return "stay";
  if (index === expanded) return "expanded";
  if (phase === DECK_PHASE.pulling) return "stay";
  if (phase === DECK_PHASE.opening) return index < expanded ? "launcher" : "slideRight";
  return index < expanded ? "slideLeft" : "slideRight";
}

export const EXPANDED_Z = 100_000;

export const DECK_Z_STEP = 4;

export const leavingZ = (index: number) => {
  "worklet";
  return Math.max(index, 0) * DECK_Z_STEP - DECK_Z_STEP / 2;
};

export type Reads<T> = { readonly value: T };

export type DeckMotion = {
  orderIds: SharedValue<readonly string[]>;
  shiftBy: SharedValue<number>;
  fromSlots: SharedValue<DeckSlots>;
  gap: SharedValue<number>;
  phase: Reads<number>;
  expandedIndex: Reads<number>;
  scroll: SharedValue<number>;
  scaleProgress: Reads<number>;
  positionProgress: Reads<number>;
  riseProgress: Reads<number>;
  revealProgress: Reads<number>;
  dragIndex: SharedValue<number>;
  dragLift: SharedValue<number>;
  leaving: SharedValue<DeckLeaving>;
  flyClock: SharedValue<number>;
  covering: Reads<string>;
};

export type DeckNow = {
  ids: readonly string[];
  scroll: number;
  phase: number;
  expanded: number;
  scaleProgress: number;
  positionProgress: number;
  riseProgress: number;
  revealProgress: number;
  dragIndex: number;
  dragLift: number;
  leaving: DeckLeaving;
  flyClock: number;
  covering: string;
  fromSlots: DeckSlots;
  shiftBy: number;
  gap: number;
};

export function deckNow(motion: DeckMotion): DeckNow {
  "worklet";
  return {
    ids: motion.orderIds.value,
    scroll: motion.scroll.value,
    phase: motion.phase.value,
    expanded: motion.expandedIndex.value,
    scaleProgress: motion.scaleProgress.value,
    positionProgress: motion.positionProgress.value,
    riseProgress: motion.riseProgress.value,
    revealProgress: motion.revealProgress.value,
    dragIndex: motion.dragIndex.value,
    dragLift: motion.dragLift.value,
    leaving: motion.leaving.value,
    flyClock: motion.flyClock.value,
    covering: motion.covering.value,
    fromSlots: motion.fromSlots.value,
    shiftBy: motion.shiftBy.value,
    gap: motion.gap.value,
  };
}

export type CardMotion = { role: DeckRole; slot: number; relative: number; lift: number; fade: number; isLast: boolean; z: number; leaving: boolean };

export function deckCardMotion(now: DeckNow, index: number, id: string): CardMotion {
  "worklet";
  const leave = now.leaving[id];
  if (leave) {
    const ms = now.flyClock - leave.t0;
    const slot = deckSlot(id, leave.at, now.fromSlots, now.shiftBy, now.gap);
    return { role: "stay", slot, relative: slot - now.scroll, lift: leave.fadeMs > 0 ? leave.lift : deckFlyLift(leave, ms), fade: deckLeaveFade(leave, ms), isLast: leave.last, z: leave.z, leaving: true };
  }
  const listed = index >= 0;
  const role = deckRole(now.phase, now.expanded, index);
  const slot = listed ? deckSlot(id, index, now.fromSlots, now.shiftBy, now.gap) : 0;
  return {
    role,
    slot,
    relative: slot - now.scroll,
    lift: listed && now.dragIndex === index ? now.dragLift : 0,
    fade: listed ? 0 : 1,
    isLast: index === now.ids.length - 1,
    z: Math.max(index, 0) * DECK_Z_STEP + (role === "expanded" ? EXPANDED_Z : 0),
    leaving: false,
  };
}

type Props = {
  tab: BrowserTab;
  index: number;
  geometry: DeckGeometry;
  motion: DeckMotion;
  onOpen: (index: number) => void;
  onClose: (index: number) => void;
  onCloseNow: (index: number) => void;
  onMenu?: (index: number, card: RefObject<ViewInstance | null>) => void;
};

type Pose = { x: number; y: number; scale: number; corner: number; opacity: number; header: number; visible: number; lift: number; fade: number };

export function cardPose(g: DeckGeometry, role: DeckRole, relative: number, sp: number, pp: number, lift: number, fade: number, isLast: boolean, rise: number = pp): Pose {
  "worklet";
  const cx = deckLeading(g, relative) + g.cardWidth / 2;
  const cy = g.cardCenterY;
  let x = cx;
  let y = cy;
  let scale = 1;
  let corner: number = DECK.cardRadius;
  let opacity = 1;
  if (role === "expanded") {
    scale = lerp(g.width / Math.max(g.cardWidth, 1), 1, sp);
    x = lerp(g.width / 2, cx, pp);
    y = lerp(g.height / 2, cy, rise);
    corner = lerp(g.screenCorner, DECK.cardRadius, sp);
  } else if (role === "launcher") {
    scale = lerp(DECK.launcherStartWidth / Math.max(g.cardWidth, 1), 1, sp);
    x = lerp(g.tabButtonX, cx, pp);
    y = lerp(g.barCenterY, cy, pp);
    corner = lerp(DECK.launcherStartRadius, DECK.cardRadius, sp);
    opacity = Math.min(1, sp * 2.5);
  } else if (role === "slideLeft") {
    x -= (1 - pp) * g.width * 0.7;
  } else if (role === "slideRight") {
    x += (1 - pp) * g.width;
  }
  const shown = 1 - Math.min(Math.max(fade, 0), 1);
  y += lift;
  opacity *= shown;
  const settle = role === "stay" ? 1 : Math.max(0, (pp - 0.7) / 0.3);
  const liftFade = Math.max(0, 1 + lift / 120);
  return { x, y, scale, corner, opacity, header: Math.min(1, settle) * Math.min(1, liftFade) * shown, visible: deckVisibleWidth(g, relative, isLast), lift, fade: 1 - shown };
}

export const DeckCard = memo(function DeckCard({ tab, index, geometry: g, motion, onOpen, onClose, onCloseNow, onMenu }: Props) {
  const reach = useRef<ViewInstance>(null);
  countRender("DeckCard");
  const theme = useTheme();
  const design = useDesign();
  const tone = shownTone(useHeldPageTone(tab.id), tab.themeColorHex);
  const { orderIds, scaleProgress, covering } = motion;
  const id = tab.id;

  const at = useDerivedValue(() => orderIds.value.indexOf(id), [id]);

  const placed = useDerivedValue(() => {
    const now = deckNow(motion);
    const m = deckCardMotion(now, at.value, id);
    const slot = cardPose(g, m.role, m.relative, now.scaleProgress, now.positionProgress, m.lift, m.fade, m.isLast, now.riseProgress);
    const pulled = now.phase === DECK_PHASE.pulling;
    const revealed = pulled ? Math.min(Math.max(now.revealProgress, 0), 1) : 1;
    const tucks = pulled && m.role !== "expanded" && now.expanded >= 0;
    const p = tucks ? { ...slot, ...pullTuck(cardPose(g, "expanded", now.expanded - now.scroll, now.scaleProgress, now.positionProgress, 0, 0, false, now.riseProgress), slot, revealed) } : slot;
    const top = p.y - (g.cardHeight * p.scale) / 2 - tabsLayout.headerGap - tabsLayout.headerHeight;
    return { pose: p, top, place: deckHeaderPlacement(p.x - (g.cardWidth * p.scale) / 2, p.visible), z: m.z, expanded: m.role === "expanded", shown: 1, headed: revealed };
  }, [g, id]);
  const cardStyle = useAnimatedStyle(() => {
    const p = placed.value.pose;
    return {
      zIndex: placed.value.z,
      opacity: covering.value === id ? 0 : p.opacity * placed.value.shown,
      borderRadius: p.corner / Math.max(p.scale, 0.01),
      transform: [{ translateX: p.x - g.cardWidth / 2 }, { translateY: p.y - g.cardHeight / 2 }, { scale: p.scale }],
    };
  }, [g]);
  const titleWidth = useSharedValue(0);
  const headerStyle = useAnimatedStyle(() => {
    const { pose: p, top, place } = placed.value;
    return {
      zIndex: placed.value.z + 1,
      opacity: p.header * placed.value.headed * deckHeaderIconReveal(place.available, tabsLayout.faviconSize),
      transform: [{ translateX: place.left + place.available - g.cardWidth }, { translateY: top }],
    };
  });
  const reachStyle = useAnimatedStyle(() => {
    const p = placed.value.pose;
    return {
      zIndex: placed.value.z + 1,
      transform: [
        { translateX: p.x - (g.cardWidth * p.scale) / 2 },
        { translateY: p.y - (g.cardHeight * p.scale) / 2 },
        { scaleX: Math.max(1, p.visible * p.scale) / g.cardWidth },
        { scaleY: p.scale },
      ],
    };
  }, [g]);
  const rowStyle = useAnimatedStyle(() => {
    const available = placed.value.place.available;
    return { transform: [{ translateX: g.cardWidth - available + deckHeaderLeading(available, tabsLayout.faviconSize, tabsLayout.headerSpacing, titleWidth.value, titleReveal(available)) }] };
  });
  const titleStyle = useAnimatedStyle(() => ({ opacity: titleReveal(placed.value.place.available) }));
  const underBars = usePageUnderBars();
  const pageTop = (tab.snapshotFileName ? snapshotPageTop(tab.snapshotFileName) : null) ?? (underBars ? 0 : g.safeTop);
  const faceStyle = useAnimatedStyle(() => ({ transform: [{ translateY: placed.value.expanded ? deckStatusStrip(g, scaleProgress.value, pageTop) : 0 }] }), [g, pageTop]);
  const bar = deckBarBand(g, barHeight(g.safeBottom), 1);
  const bandStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: placed.value.expanded && !underBars ? deckBarBand(g, 0, scaleProgress.value).grown : 0 }] }), [g, underBars]);

  const host = display(tab.url).host;
  const title = tab.title || host || "New Tab";
  const cardContents = (
    <>
      <Animated.View testID="deckCardFace" style={[StyleSheet.absoluteFill, faceStyle]}>
        <TabFace tab={tab} title={title} host={host} tone={tone.top} roles={theme} paintedAs={`deck:${tab.id}`} />
      </Animated.View>
      <Animated.View testID="deckCardBarBand" pointerEvents="none" style={[styles.band, { height: bar.height, backgroundColor: tone.bottom ?? theme.surface }, bandStyle]}>
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
        style={[
          styles.card,
          { width: g.cardWidth, height: g.cardHeight, borderColor: theme.cardEdge, backgroundColor: tone.top ?? theme.surface },
          cardStyle,
        ]}
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
        ref={reach}
        accessible
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityValue={{ text: tab.isPrivate ? `Incognito, ${host}` : host }}
        accessibilityHint="Opens the tab."
        {...screenReaderActions([
          { name: "activate", run: () => onOpen(index) },
          { name: "close", label: "Close Tab", run: () => onCloseNow(index) },
          ...(onMenu ? [{ name: "menu", label: CARD_MENU_ACTION, run: () => onMenu(index, reach) }] : []),
        ])}
        pointerEvents="none"
        style={[styles.reach, { width: g.cardWidth, height: g.cardHeight }, reachStyle]}
      />
      <Animated.View style={[styles.header, { width: g.cardWidth }, headerStyle]} pointerEvents="none">
        <FadeView testID="deckHeaderFade" trailing={{ length: DECK_HEADER.trailingFade }} style={StyleSheet.absoluteFill}>
          <Animated.View style={[styles.headerRow, rowStyle]}>
            <CardIcon tab={tab} />
            <Animated.Text
              testID="deckHeaderTitle"
              maxFontSizeMultiplier={DECK_HEADER.maxFontScale}
              onLayout={(event) => {
                titleWidth.value = event.nativeEvent.layout.width;
              }}
              style={[HEADER_TITLE_FONT, styles.title, { color: theme.headerText }, titleStyle]}
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

type SendTarget = ReturnType<typeof sendTargetsFor>[number];

type CardMenuContext = { devices: SendTarget[]; pinned: boolean; syncEnabled: boolean; spaces: SyncedProfile[] };

const deviceSystemImage = (device: Pick<SendTarget, "name" | "kind">) => (device.kind === "phone" ? "iphone" : /book/i.test(device.name) ? "laptopcomputer" : "desktopcomputer");

export function cardMenuItems(tab: BrowserTab, { devices, pinned, syncEnabled, spaces }: CardMenuContext, close: () => void): MenuItem[] {
  const closing: MenuItem = { label: "Close Tab", destructive: true, onPress: close };
  if (!canShareTab(tab)) return [closing];
  const send = (device: SendTarget) => () => void sendTab(tab, device);
  const sends: MenuItem[] =
    devices.length === 1
      ? [{ label: `Send to ${devices[0]!.name}`, icon: devices[0]!.kind === "phone" ? "iphone" : "laptop", systemImage: deviceSystemImage(devices[0]!), onPress: send(devices[0]!) }]
      : devices.length > 1
        ? [{ label: "Send to Device", children: devices.map((device): MenuItem => ({ label: device.name, icon: device.kind === "phone" ? "iphone" : "laptop", systemImage: deviceSystemImage(device), onPress: send(device) })) }]
        : [];
  const pin: MenuItem[] = tab.isPrivate || !syncEnabled ? [] : pinned ? [{ label: "Pinned to Mac", disabled: true, onPress: () => undefined }] : [{ label: "Pin to Mac", onPress: () => void pinToMac(tab, () => openSettings({ page: "sync" })) }];
  const others = tab.isPrivate ? [] : spaces;
  const move: MenuItem[] = others.length ? [{ label: "Move to Space", children: others.map((space): MenuItem => ({ label: space.name, systemImage: spaceSystemImage(space.name, space.icon), onPress: () => moveTabToSpace(tab.id, space.syncId) })) }] : [];
  return [{ label: "Copy Link", onPress: () => copyTabLink(tab) }, { label: "Share", onPress: () => shareTab(tab) }, ...sends, ...pin, ...move, "divider", closing];
}

type CardMenuProps = { tab: BrowserTab; close: () => void; testID: string; haptic?: () => void; style?: StyleProp<ViewStyle>; children: (handlers: MenuHandlers) => ReactNode };

export function CardMenu({ tab, close, testID, haptic, style, children }: CardMenuProps) {
  const devices = useSendTargets(tab.id);
  const pinned = useIsPinned(tab.id);
  const syncEnabled = useSyncEnabled();
  const tabSpaces = useTabSpaces();
  const profiles = useSyncView().profiles;
  const spaces = moveTargets(tabSpaces, profiles, tab);
  return (
    <MenuTrigger testID={testID} items={cardMenuItems(tab, { devices, pinned, syncEnabled, spaces }, close)} trigger="longPress" haptic={haptic} privately={tab.isPrivate} onOpen={hideArchiveCard} style={style}>
      {children}
    </MenuTrigger>
  );
}

export const CARD_MENU_ACTION = "Tab Options";

export function DeckCardMenu({ tab, index, onClose, fill, children }: { tab: BrowserTab; index: number; onClose: (index: number) => void; fill: string; children: ReactNode }) {
  return (
    <CardMenu testID="deckCardMenu" tab={tab} close={() => onClose(index)} style={[styles.cardMenu, { backgroundColor: fill }]}>
      {() => children}
    </CardMenu>
  );
}

export const deckHeaderTitle = (tab: BrowserTab, title: string): string => (tab.isPrivate ? iPhoneOr("Incognito", title) : title);

export function CardIcon({ tab }: { tab: BrowserTab }) {
  return tab.isPrivate ? (
    <View style={[styles.privateIcon, { backgroundColor: tabsInk.incognitoCardRaised }]}>
      <IncognitoSpecs size={tabsLayout.specsIcon} color={tabsInk.onDark} />
    </View>
  ) : (
    <Favicon iconUrl={tab.faviconUrl} pageUrl={tab.url} size={tabsLayout.faviconSize} />
  );
}

export type CardOpen = "openingCard" | "coveringCard" | "deckCard" | "pulledCard";

const androidCardOpen = (): CardOpen => (isLabBuild && launchArguments().openingCard ? "coveringCard" : "deckCard");

export const cardOpen: () => CardOpen = iPhoneOr(() => "openingCard", androidCardOpen);

export const OPENING_CARD_RESPONSE = iPhoneOr(0.18, 0.3);
export const OPENING_CARD_MOTION: MotionCurve = { type: "spring", response: OPENING_CARD_RESPONSE, dampingFraction: 1 };

type OpeningCardProps = { tab: BrowserTab; geometry: DeckGeometry; centerX: number; centerY: number; growsAtMount?: boolean; endsSquare?: boolean; onGrowing: () => void; onLanded?: () => void };

export type CoverFrame = { left: number; top: number; width: number; height: number; startScale: number; scale: number };

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export function coverFrame(g: DeckGeometry, ratio: number = PixelRatio.get()): CoverFrame {
  const screenWidth = Math.round(g.width * ratio);
  const screenHeight = Math.round(g.height * ratio);
  const unit = Math.max(gcd(screenWidth, screenHeight), 1);
  const across = screenWidth / unit;
  const down = screenHeight / unit;
  let steps = Math.max(Math.ceil((g.cardWidth * ratio) / across), 1);
  while (steps < unit && ((screenWidth - across * steps) % 2 !== 0 || (screenHeight - down * steps) % 2 !== 0)) steps++;
  steps = Math.min(steps, unit);
  const width = (across * steps) / ratio;
  const height = (down * steps) / ratio;
  return { left: (screenWidth - across * steps) / 2 / ratio, top: (screenHeight - down * steps) / 2 / ratio, width, height, startScale: g.cardWidth / width, scale: screenWidth / (across * steps) };
}

const deckCardFrame = (g: DeckGeometry): CoverFrame => ({ left: (g.width - g.cardWidth) / 2, top: (g.height - g.cardHeight) / 2, width: g.cardWidth, height: g.cardHeight, startScale: 1, scale: g.width / Math.max(g.cardWidth, 1) });

export function OpeningCard({ tab, geometry: g, centerX, centerY, growsAtMount = false, endsSquare = false, onGrowing, onLanded }: OpeningCardProps) {
  const [frame] = useState(() => (endsSquare ? coverFrame(g) : deckCardFrame(g)));
  const inner = { ...g, cardWidth: frame.width, cardHeight: frame.height };
  const theme = useTheme();
  const design = useDesign();
  const toneNow = shownTone(useHeldPageTone(tab.id), tab.themeColorHex);
  const [tone] = useState(toneNow);
  const underBars = usePageUnderBars();
  const [grown, setGrown] = useState(growsAtMount);
  useEffect(() => {
    if (growsAtMount) return;
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (grown) onGrowing();
  }, [grown]);
  const pageTop = (tab.snapshotFileName ? snapshotPageTop(tab.snapshotFileName) : null) ?? (underBars ? 0 : g.safeTop);
  const full = frame.scale;
  const bar = deckBarBand(inner, barHeight(g.safeBottom), 1);
  const host = display(tab.url).host;
  const title = tab.title || host || "New Tab";
  const start = { translateX: centerX - g.width / 2, translateY: centerY - g.height / 2, scale: frame.startScale, cornerRadius: DECK.cardRadius / frame.startScale };
  const to = grown ? { translateX: 0, translateY: 0, scale: full, cornerRadius: endsSquare ? 0 : DECK.displayCornerRadius / full } : start;
  return (
    <MotionView
      testID="openingCard"
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      from={growsAtMount ? start : undefined}
      to={to}
      motion={OPENING_CARD_MOTION}
      onMotionEnd={onLanded ? (finished) => finished && onLanded() : undefined}
      {...(endsSquare && onLanded && motionReportsNearEnd() ? { nativeID: OPENING_COVER_ID, nearEndPx: COVER_NEAR_END_PX, onMotionNearEnd: () => onLanded() } : endsSquare ? { nativeID: OPENING_COVER_ID } : {})}
      style={[styles.opening, endsSquare ? null : styles.openingEdge, { left: frame.left, top: frame.top, width: frame.width, height: frame.height, borderColor: theme.cardEdge, backgroundColor: tone.top ?? theme.surface }]}
    >
      <MotionView testID="openingCardFace" style={StyleSheet.absoluteFill} from={growsAtMount ? { translateY: 0 } : undefined} to={{ translateY: grown ? deckStatusStrip(inner, 0, pageTop) : 0 }} motion={OPENING_CARD_MOTION}>
        <TabFace tab={tab} title={title} host={host} tone={tone.top} roles={theme} paintedAs={`deck:${tab.id}`} />
      </MotionView>
      {underBars ? null : (
        <MotionView testID="openingCardBand" pointerEvents="none" style={StyleSheet.absoluteFill} from={growsAtMount ? { translateY: bar.height } : undefined} to={{ translateY: grown ? 0 : bar.height }} motion={OPENING_CARD_MOTION}>
          <View testID="openingCardBandFill" style={[styles.openingBand, { top: frame.height - bar.height, width: frame.width, height: bar.height, backgroundColor: tone.bottom ?? theme.surface }]}>
            {design === "original" ? <View style={[StyleSheet.absoluteFill, { backgroundColor: isDarkColor(tone.bottom ?? theme.surface) ? tabsInk.barShadeOnDark : tabsInk.barShadeOnLight }]} /> : null}
          </View>
        </MotionView>
      )}
      {endsSquare ? (
        <MotionView testID="openingCardEdge" pointerEvents="none" style={[styles.openingEdgeOverlay, { borderColor: theme.cardEdge }]} from={growsAtMount ? { opacity: 1 } : undefined} to={{ opacity: grown ? 0 : 1 }} motion={OPENING_CARD_MOTION} />
      ) : null}
    </MotionView>
  );
}

const CARD_ELEVATION = 14;
const COVER_NEAR_END_PX = 2;
const HEADER_ROW_ROOM = 2000;
const HEADER_TITLE_FONT = iPhoneOr<{ fontSize: number; lineHeight: number }>(font.footnote, font.caption);
const CARD_SHADOW_BLUR = 36;
const RECEIVED_INSET = 10;

export function ReceivedBadge() {
  const theme = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: theme.formAccent, boxShadow: `0px 2px 12px ${theme.formAccent}59` }]}>
      <Symbol name="laptop" size={12} color={tabsInk.onDark} />
      <Text style={[styles.badgeText, { color: tabsInk.onDark }]}>From Your Mac</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    left: 0,
    top: 0,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    ...Platform.select({ android: { elevation: CARD_ELEVATION, shadowColor: tabsInk.cardShadow }, default: { boxShadow: `-2px 4px ${CARD_SHADOW_BLUR}px ${tabsInk.cardShadow}` } }),
  },
  band: { position: "absolute", left: 0, right: 0, bottom: 0, transformOrigin: "bottom" },
  cardMenu: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: DECK.cardRadius },
  opening: { position: "absolute", overflow: "hidden" },
  openingEdge: { borderWidth: StyleSheet.hairlineWidth },
  openingEdgeOverlay: { ...StyleSheet.absoluteFill, borderWidth: StyleSheet.hairlineWidth },
  openingBand: { position: "absolute", left: 0 },
  badge: {
    position: "absolute",
    top: RECEIVED_INSET,
    left: RECEIVED_INSET,
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.s,
    paddingVertical: space.xs,
    borderRadius: 999,
  },
  badgeText: { fontSize: 11, lineHeight: 13, fontWeight: "600" },
  reach: { position: "absolute", left: 0, top: 0, transformOrigin: "left top" },
  header: { position: "absolute", left: 0, top: 0, height: tabsLayout.headerHeight, overflow: "hidden" },
  headerRow: { position: "absolute", left: 0, top: 0, width: HEADER_ROW_ROOM, flexDirection: "row", alignItems: "center", gap: tabsLayout.headerSpacing, height: tabsLayout.headerHeight },
  title: { fontWeight: "500" },
  privateIcon: { width: tabsLayout.faviconSize, height: tabsLayout.faviconSize, borderRadius: tabsLayout.faviconRadius, alignItems: "center", justifyContent: "center" },
});

export { styles as deckCardStyles };
