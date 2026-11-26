import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Image, Pressable, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { displayHost, displayUrl, hostOf } from "@ardia/core";
import { tabTitle } from "../../state/browser/model";
import { useTab, useTabLive } from "../../state/browser/hooks";
import { useSidebarUi } from "../../state/sidebar/sidebarUi";
import { lastPicture, onPicturesChanged } from "../../state/tabs/tabPictures";
import { commitSwitcher, hoverSwitcherRow, leaveSwitcherRow, subscribeSwitcherTabChanges } from "../../state/sidebar/switcher";
import { noteTabSwitcherOverflowClick, noteTabSwitcherOverflowOpened, noteTabSwitcherPictureLate, noteTabSwitcherWheelScrolled } from "../../state/telemetry/tabSwitcherOpens";
import { clippedContinuousCorners, continuousCorners, Symbol, Text, Panel } from "../ui";
import { useTheme } from "../ui/theme";
import { TabIcon } from "./TabIcon";
import { previewBackdrop } from "./switcherPreview";
import { revealedOffset } from "./switcherScroll";
import { SIDEBAR_SHADOW, TAB_SWITCHER as T, TAB_SWITCHER_LIST_ID, TAB_SWITCHER_SCROLL_ID, tabSwitcherColors } from "./tokens";

const SHOT = Math.round(T.card / T.shotAspect);
const SHOT_WIDTH = T.card - 2 * T.cardInset;
const ROW_HEIGHT = SHOT + T.label + 2 * T.cardInset;
const STRIDE = T.card + T.gap;
const OWN_SCROLL_MS = 120;
const OWN_ANIMATED_SCROLL_MS = 450;

export function TabSwitcher({ windowId, windowWidth, windowHeight }: { windowId: string; windowWidth: number; windowHeight: number }) {
  const theme = useTheme();
  const pendingSwitcher = useSidebarUi((u) => (u.switcher?.windowId === windowId ? u.switcher : null));
  const switcher = pendingSwitcher?.mounted ? pendingSwitcher : null;

  useEffect(() => {
    if (!pendingSwitcher) return;
    return subscribeSwitcherTabChanges(windowId);
  }, [pendingSwitcher?.windowId, windowId]);

  if (!switcher || switcher.view === "none") return null;
  const list = switcher.view === "compactList";
  const fits = list
    ? Math.max(1, Math.floor((windowHeight - T.windowMargin - 2 * T.pad) / T.list.row))
    : Math.max(1, Math.floor((windowWidth - T.windowMargin - 2 * T.pad + T.gap) / (T.card + T.gap)));
  const count = Math.min(fits, list ? T.list.maxRows : T.maxCards, switcher.ids.length);
  const viewport = list ? count * T.list.row : count * T.card + (count - 1) * T.gap;
  const width = list ? Math.min(T.list.width, windowWidth - T.windowMargin) : 2 * T.pad + viewport;
  const height = 2 * T.pad + (list ? viewport : ROW_HEIGHT);

  return (
    <View
      pointerEvents={switcher.visible ? "auto" : "none"}
      style={{
        position: "absolute",
        left: (windowWidth - width) / 2,
        top: (windowHeight - height) / 2,
        width,
        height,
        opacity: switcher.visible ? 1 : 0,
      }}
    >
      <Panel
        fill={tabSwitcherColors(theme.dark).fill}
        radius={T.panelRadius}
        border={theme.panelBorder}
        shadow={SIDEBAR_SHADOW.tabSwitcher}
        style={StyleSheet.absoluteFill}
      />
      {list ? (
        <SwitcherList ids={switcher.ids} index={switcher.index} viewport={viewport} width={width - 2 * T.pad} overflows={count < switcher.ids.length} visible={switcher.visible} />
      ) : (
        <SwitcherRow ids={switcher.ids} index={switcher.index} viewport={viewport} overflows={count < switcher.ids.length} accent={theme.accent} visible={switcher.visible} />
      )}
    </View>
  );
}

function useRevealedScroll(index: number, viewport: number, size: number, stride: number, horizontal: boolean, visible: boolean) {
  const scroll = useRef<ScrollView>(null);
  const [opening] = useState(() => {
    const at = revealedOffset(index, 0, viewport, size, stride);
    return horizontal ? { x: at, y: 0 } : { x: 0, y: at };
  });
  const offset = useRef(horizontal ? opening.x : opening.y);
  const placed = useRef(false);
  const shownIndex = useRef(index);
  const ownScrollUntil = useRef(0);
  const wheeled = useRef(false);

  const scrollTo = (at: number, animated: boolean) => {
    offset.current = at;
    ownScrollUntil.current = performance.now() + (animated ? OWN_ANIMATED_SCROLL_MS : OWN_SCROLL_MS);
    scroll.current?.scrollTo(horizontal ? { x: at, animated } : { y: at, animated });
  };

  useEffect(() => {
    const moved = shownIndex.current !== index;
    shownIndex.current = index;
    if (!placed.current) return;
    const next = revealedOffset(index, offset.current, viewport, size, stride);
    if (Math.abs(next - offset.current) >= 0.5) scrollTo(next, moved);
  }, [index, viewport]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = horizontal ? e.nativeEvent.contentOffset.x : e.nativeEvent.contentOffset.y;
    if (!visible || wheeled.current || performance.now() < ownScrollUntil.current) return;
    wheeled.current = true;
    noteTabSwitcherWheelScrolled();
  };

  const onContentSizeChange = () => {
    if (placed.current) return void (ownScrollUntil.current = performance.now() + OWN_SCROLL_MS);
    placed.current = true;
    scrollTo(revealedOffset(shownIndex.current, offset.current, viewport, size, stride), false);
  };

  return { scroll, opening, onScroll, onContentSizeChange };
}

function useOverflowNoted(visible: boolean, overflows: boolean) {
  const noted = useRef(false);
  useEffect(() => {
    if (!visible || !overflows || noted.current) return;
    noted.current = true;
    noteTabSwitcherOverflowOpened();
  }, [visible, overflows]);
}

function SwitcherRow({ ids, index, viewport, overflows, accent, visible }: { ids: string[]; index: number; viewport: number; overflows: boolean; accent: string; visible: boolean }) {
  const { scroll, opening, onScroll, onContentSizeChange } = useRevealedScroll(index, viewport, T.card, STRIDE, true, visible);
  useOverflowNoted(visible, overflows);

  return (
    <ScrollView
      ref={scroll}
      horizontal
      testID={TAB_SWITCHER_SCROLL_ID}
      showsHorizontalScrollIndicator={false}
      scrollEnabled={overflows}
      scrollEventThrottle={16}
      contentOffset={opening}
      onContentSizeChange={onContentSizeChange}
      onScroll={onScroll}
      style={{ margin: T.pad, width: viewport, height: ROW_HEIGHT }}
      contentContainerStyle={{ gap: T.gap }}
    >
      {ids.map((id, i) => (
        <SwitcherCard key={id} tabId={id} index={i} focused={i === index} accent={accent} overflows={overflows} visible={visible} />
      ))}
    </ScrollView>
  );
}

const SwitcherCard = memo(function SwitcherCard({ tabId, index, focused, accent, overflows, visible }: { tabId: string; index: number; focused: boolean; accent: string; overflows: boolean; visible: boolean }) {
  const tab = useTab(tabId);
  const colors = tabSwitcherColors(useTheme().dark);
  const themeColor = useTabLive(tabId, (live) => live.themeColor);
  const picture = useSyncExternalStore(onPicturesChanged, () => lastPicture(tabId));
  const pictureData = picture?.data;
  const source = useMemo(() => (pictureData ? { uri: `data:image/jpeg;base64,${pictureData}` } : null), [pictureData]);
  const [decoded, setDecoded] = useState<object | null>(null);
  const lateNoted = useRef(false);
  const late = visible && !!source && decoded !== source;
  useEffect(() => {
    if (!late || lateNoted.current) return;
    lateNoted.current = true;
    noteTabSwitcherPictureLate();
  }, [late]);
  useEffect(() => () => leaveSwitcherRow(index), [index]);
  if (!tab) return null;
  const url = tab.url || tab.pinnedUrl || "";
  const backdrop = previewBackdrop(url ? themeColor : null, colors);
  const shown = !!source && decoded === source;

  return (
    <Pressable
      onPressIn={() => {
        if (overflows) noteTabSwitcherOverflowClick();
        commitSwitcher(index);
      }}
    >
      <View
        onMouseEnter={() => hoverSwitcherRow(index)}
        onMouseLeave={() => leaveSwitcherRow(index)}
      >
        <View style={{ width: T.card, padding: T.cardInset, ...continuousCorners(T.cardRadius), backgroundColor: focused ? colors.focusFill : undefined }}>
          <View
            style={{
              width: SHOT_WIDTH,
              height: SHOT,
              ...continuousCorners(T.previewRadius),
              overflow: "hidden",
              backgroundColor: backdrop.fill,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {!shown && <TabIcon tabId={tab.id} url={url} favicon={tab.favicon} icon={tab.customIcon} profileId={tab.profileId} size={T.icon.preview} color={backdrop.icon} />}
            {source && (
              <Image
                source={source}
                resizeMode="cover"
                onLoad={() => setDecoded(source)}
                style={[StyleSheet.absoluteFill, continuousCorners(T.previewRadius), { opacity: shown ? 1 : 0 }]}
              />
            )}
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                {
                  ...clippedContinuousCorners(T.previewRadius),
                  borderWidth: focused ? T.ring.focused : T.ring.rest,
                  borderColor: focused ? accent : colors.restRing,
                },
              ]}
            />
          </View>
          <View style={{ height: T.label, flexDirection: "row", alignItems: "center", gap: T.labelGap, paddingHorizontal: T.labelInset }}>
            {url || tab.customIcon ? (
              <TabIcon tabId={tab.id} url={url} favicon={tab.favicon} icon={tab.customIcon} profileId={tab.profileId} size={T.icon.label} color={colors.onPanel} />
            ) : (
              <Symbol name="globe" size={T.icon.globe} color={colors.onPanel} style={{ width: T.icon.label, height: T.icon.label }} />
            )}
            <Text lines={1} weight="semibold" color={colors.title} style={{ flex: 1, fontSize: T.titleSize }}>
              {tabTitle(tab)}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
});

function SwitcherList({ ids, index, viewport, width, overflows, visible }: { ids: string[]; index: number; viewport: number; width: number; overflows: boolean; visible: boolean }) {
  const { scroll, opening, onScroll, onContentSizeChange } = useRevealedScroll(index, viewport, T.list.row, T.list.row, false, visible);
  useOverflowNoted(visible, overflows);
  return (
    <ScrollView
      ref={scroll}
      testID={TAB_SWITCHER_LIST_ID}
      showsVerticalScrollIndicator={false}
      scrollEnabled={overflows}
      scrollEventThrottle={16}
      contentOffset={opening}
      onContentSizeChange={onContentSizeChange}
      onScroll={onScroll}
      style={{ margin: T.pad, width, height: viewport }}
    >
      {ids.map((id, i) => (
        <SwitcherListRow key={id} tabId={id} index={i} focused={i === index} overflows={overflows} />
      ))}
    </ScrollView>
  );
}

const SwitcherListRow = memo(function SwitcherListRow({ tabId, index, focused, overflows }: { tabId: string; index: number; focused: boolean; overflows: boolean }) {
  const tab = useTab(tabId);
  const colors = tabSwitcherColors(useTheme().dark);
  useEffect(() => () => leaveSwitcherRow(index), [index]);
  if (!tab) return null;
  const url = tab.url || tab.pinnedUrl || "";
  const site = url ? displayHost(hostOf(url)) || displayUrl(url) : "";
  return (
    <Pressable
      onPressIn={() => {
        if (overflows) noteTabSwitcherOverflowClick();
        commitSwitcher(index);
      }}
    >
      <View
        onMouseEnter={() => hoverSwitcherRow(index)}
        onMouseLeave={() => leaveSwitcherRow(index)}
        style={{
          height: T.list.row,
          flexDirection: "row",
          alignItems: "center",
          gap: T.list.gap,
          paddingHorizontal: T.list.inset,
          ...continuousCorners(T.cardRadius),
          backgroundColor: focused ? colors.focusFill : undefined,
        }}
      >
        {url || tab.customIcon ? (
          <TabIcon tabId={tab.id} url={url} favicon={tab.favicon} icon={tab.customIcon} profileId={tab.profileId} size={T.list.icon} color={colors.onPanel} />
        ) : (
          <Symbol name="globe" size={T.icon.globe} color={colors.onPanel} style={{ width: T.list.icon, height: T.list.icon }} />
        )}
        <View style={{ flex: 1, gap: T.list.lineGap }}>
          <Text lines={1} weight={focused ? "semibold" : "medium"} color={colors.title} style={{ fontSize: T.titleSize }}>
            {tabTitle(tab)}
          </Text>
          {site ? (
            <Text lines={1} size="caption" color={colors.onPanel}>
              {site}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});
