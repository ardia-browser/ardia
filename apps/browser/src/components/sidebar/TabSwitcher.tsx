import { Panel, Text } from "../ui";
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dimensions, Image, Pressable, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { lastPicture, onPicturesChanged } from "../../state/tabs/tabPictures";
import { useTheme } from "../ui/theme";
import { useTab } from "../../state/browser/hooks";
import { TabIcon } from "./TabIcon";
import { tabTitle } from "../../state/browser/model";
import { useSidebarUi } from "../../state/sidebar/sidebarUi";
import { commitSwitcher, hoverSwitcherRow, leaveSwitcherRow, subscribeSwitcherTabChanges } from "../../state/sidebar/switcher";
import { TAB_SWITCHER as T, SIDEBAR_SHADOW, TAB_SWITCHER_SCROLL_ID } from "./tokens";
import { revealedOffset } from "./switcherScroll";
import { noteTabSwitcherOverflowClick, noteTabSwitcherOverflowOpened, noteTabSwitcherWheelScrolled } from "../../state/telemetry/tabSwitcherOpens";

const OWN_SCROLL_MS = 120;
const OWN_ANIMATED_SCROLL_MS = 450;

const { cardPadding, cardBorder, panelSide, panelTop, panelBottom, cardTopOffset, labelGap, labelHeight } = T;
const cardInset = cardPadding + cardBorder;
const subscribeScreen = (listener: () => void) => {
  const subscription = Dimensions.addEventListener("change", listener);
  return () => subscription.remove();
};
const screenSnapshot = () => Dimensions.get("screen");

export function TabSwitcher({ windowId, windowWidth, windowHeight }: { windowId: string; windowWidth: number; windowHeight: number }) {
  const theme = useTheme();
  const screen = useSyncExternalStore(subscribeScreen, screenSnapshot);
  const pendingSwitcher = useSidebarUi((u) => (u.switcher?.windowId === windowId ? u.switcher : null));
  const switcher = pendingSwitcher?.visible ? pendingSwitcher : null;
  useEffect(() => {
    if (!pendingSwitcher) return;
    return subscribeSwitcherTabChanges(windowId);
  }, [pendingSwitcher?.windowId, windowId]);
  if (!switcher) return null;
  const aspect = screen.height / screen.width;
  const roomWidth = Math.max(1, windowWidth - 2 * T.windowMargin - 2 * panelSide);
  const availableWidth = Math.min(roomWidth - 2 * cardInset, roomWidth / T.columnScale);
  const availableHeight = Math.max(1, windowHeight - 2 * T.windowMargin - panelTop - cardTopOffset - panelBottom - labelGap - labelHeight - 2 * cardInset);
  const pictureWidth = Math.max(1, Math.min(Math.ceil(screen.width * T.screenFraction / T.referenceColumns), availableWidth, Math.floor(availableHeight / aspect)));
  const pictureHeight = Math.max(1, Math.round(pictureWidth * aspect));
  const targetColumnWidth = Math.max(pictureWidth + 2 * cardInset, pictureWidth * T.columnScale);
  const fits = Math.max(1, Math.floor(roomWidth / targetColumnWidth));
  const count = Math.min(fits, switcher.ids.length);
  const width = Math.max(2 * panelSide + count * (pictureWidth + 2 * cardInset), count * targetColumnWidth);
  const columnWidth = (width - 2 * panelSide) / count;
  const rowHeight = pictureHeight + labelGap + labelHeight + 2 * cardInset;
  const height = panelTop + cardTopOffset + rowHeight + panelBottom;
  return (
    <View
      style={{
        position: "absolute",
        left: (windowWidth - width) / 2,
        top: (windowHeight - height) / 2,
        width,
        height,
      }}
    >
      <Panel
        fill={theme.dark ? T.fill.dark : T.fill.light}
        radius={T.panelRadius}
        border={theme.panelBorder}
        shadow={SIDEBAR_SHADOW.tabSwitcher}
        style={StyleSheet.absoluteFill}
      />
      <SwitcherRow ids={switcher.ids} index={switcher.index} viewport={count * columnWidth} overflows={count < switcher.ids.length} accent={theme.accent} pictureWidth={pictureWidth} pictureHeight={pictureHeight} columnWidth={columnWidth} rowHeight={rowHeight} />
    </View>
  );
}

function SwitcherRow({ ids, index, viewport, overflows, accent, pictureWidth, pictureHeight, columnWidth, rowHeight }: { ids: string[]; index: number; viewport: number; overflows: boolean; accent: string; pictureWidth: number; pictureHeight: number; columnWidth: number; rowHeight: number }) {
  const scroll = useRef<ScrollView>(null);
  const [opening] = useState(() => ({ x: revealedOffset(index, 0, viewport, columnWidth, columnWidth), y: 0 }));
  const offset = useRef(opening.x);
  const placed = useRef(false);
  const shownIndex = useRef(index);
  const ownScrollUntil = useRef(0);
  const wheeled = useRef(false);

  const scrollTo = (x: number, animated: boolean) => {
    offset.current = x;
    ownScrollUntil.current = performance.now() + (animated ? OWN_ANIMATED_SCROLL_MS : OWN_SCROLL_MS);
    scroll.current?.scrollTo({ x, animated });
  };

  useEffect(() => {
    if (overflows) noteTabSwitcherOverflowOpened();
  }, []);

  useEffect(() => {
    const moved = shownIndex.current !== index;
    shownIndex.current = index;
    if (!placed.current) return;
    const next = revealedOffset(index, offset.current, viewport, columnWidth, columnWidth);
    if (Math.abs(next - offset.current) >= 0.5) scrollTo(next, moved);
  }, [index, viewport, columnWidth]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = e.nativeEvent.contentOffset.x;
    if (wheeled.current || performance.now() < ownScrollUntil.current) return;
    wheeled.current = true;
    noteTabSwitcherWheelScrolled();
  };

  return (
    <ScrollView
      ref={scroll}
      horizontal
      testID={TAB_SWITCHER_SCROLL_ID}
      showsHorizontalScrollIndicator={false}
      scrollEnabled={overflows}
      scrollEventThrottle={16}
      contentOffset={opening}
      onContentSizeChange={() => {
        if (placed.current) return void (ownScrollUntil.current = performance.now() + OWN_SCROLL_MS);
        placed.current = true;
        scrollTo(revealedOffset(shownIndex.current, offset.current, viewport, columnWidth, columnWidth), false);
      }}
      onScroll={onScroll}
      style={{ marginHorizontal: panelSide, marginTop: panelTop + cardTopOffset, width: viewport, height: rowHeight }}
    >
      {ids.map((id, i) => (
        <SwitcherCard key={id} tabId={id} index={i} focused={i === index} accent={accent} overflows={overflows} pictureWidth={pictureWidth} pictureHeight={pictureHeight} columnWidth={columnWidth} />
      ))}
    </ScrollView>
  );
}

const SwitcherCard = memo(function SwitcherCard({ tabId, index, focused, accent, pictureWidth, pictureHeight, columnWidth, overflows }: { tabId: string; index: number; focused: boolean; accent: string; pictureWidth: number; pictureHeight: number; columnWidth: number; overflows: boolean }) {
  const theme = useTheme();
  const tab = useTab(tabId);
  const picture = useSyncExternalStore(onPicturesChanged, () => lastPicture(tabId));
  useEffect(() => () => leaveSwitcherRow(index), [index]);
  if (!tab) return null;
  const url = tab.url || tab.pinnedUrl || "";
  return (
    <Pressable onPressIn={() => {
      if (overflows) noteTabSwitcherOverflowClick();
      commitSwitcher(index);
    }} style={{ width: columnWidth, alignItems: "center" }}>
      <View
        onMouseEnter={() => hoverSwitcherRow(index)}
        onMouseLeave={() => leaveSwitcherRow(index)}
        style={{ width: pictureWidth + 2 * cardInset, padding: cardPadding, borderWidth: cardBorder, borderColor: focused ? accent : T.restRing, borderRadius: T.cardRadius, backgroundColor: focused ? T.focusFill : undefined }}
      >
        <View
          style={{
            width: pictureWidth,
            height: pictureHeight,
            borderRadius: T.shotRadius,
            overflow: "hidden",
            backgroundColor: picture ? undefined : url ? T.pageFill : T.blankFill,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {picture ? (
            <Image source={{ uri: `data:image/jpeg;base64,${picture.data}` }} resizeMode="cover" style={StyleSheet.absoluteFill} />
          ) : (
            <TabIcon tabId={tab.id} url={url} favicon={tab.favicon} icon={tab.customIcon} profileId={tab.profileId} size={30} color={url ? T.onPage : T.onPanel} />
          )}
        </View>
        {url || tab.customIcon ? (
          <View pointerEvents="none" style={{ position: "absolute", top: cardPadding + pictureHeight + T.badgeBottom - T.badgeSize, right: cardPadding + T.badgeRight, width: T.badgeSize, height: T.badgeSize, padding: T.badgePadding, borderWidth: T.badgeBorder, borderColor: theme.divider, borderRadius: T.badgeRadius, backgroundColor: theme.panel, alignItems: "center", justifyContent: "center" }}>
            <TabIcon tabId={tab.id} url={url} favicon={tab.favicon} icon={tab.customIcon} profileId={tab.profileId} size={T.badgeSize - 2 * (T.badgePadding + T.badgeBorder)} />
          </View>
        ) : null}
        <Text lines={1} size="body" weight="regular" color={T.pageFill} style={{ width: pictureWidth, marginTop: labelGap, height: labelHeight, lineHeight: labelHeight, textAlign: "center" }}>
          {tabTitle(tab)}
        </Text>
      </View>
    </Pressable>
  );
});
