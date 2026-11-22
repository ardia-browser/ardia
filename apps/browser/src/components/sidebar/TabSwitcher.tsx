import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Image, Pressable, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { tabTitle } from "../../state/browser/model";
import { useTab, useTabLive } from "../../state/browser/hooks";
import { useSidebarUi } from "../../state/sidebar/sidebarUi";
import { lastPicture, onPicturesChanged } from "../../state/tabs/tabPictures";
import { commitSwitcher, hoverSwitcherRow, leaveSwitcherRow, subscribeSwitcherTabChanges } from "../../state/sidebar/switcher";
import { noteTabSwitcherOverflowClick, noteTabSwitcherOverflowOpened, noteTabSwitcherPictureLate, noteTabSwitcherWheelScrolled } from "../../state/telemetry/tabSwitcherOpens";
import { Symbol, Text, Panel } from "../ui";
import { useTheme } from "../ui/theme";
import { TabIcon } from "./TabIcon";
import { previewBackdrop } from "./switcherPreview";
import { revealedOffset } from "./switcherScroll";
import { SIDEBAR_SHADOW, TAB_SWITCHER as T, TAB_SWITCHER_SCROLL_ID, tabSwitcherColors } from "./tokens";

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

  if (!switcher) return null;
  const fits = Math.max(1, Math.floor((windowWidth - T.windowMargin - 2 * T.pad + T.gap) / (T.card + T.gap)));
  const count = Math.min(fits, switcher.ids.length);
  const viewport = count * T.card + (count - 1) * T.gap;
  const width = 2 * T.pad + viewport;
  const height = 2 * T.pad + ROW_HEIGHT;

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
      <SwitcherRow ids={switcher.ids} index={switcher.index} viewport={viewport} overflows={count < switcher.ids.length} accent={theme.accent} visible={switcher.visible} />
    </View>
  );
}

function SwitcherRow({ ids, index, viewport, overflows, accent, visible }: { ids: string[]; index: number; viewport: number; overflows: boolean; accent: string; visible: boolean }) {
  const scroll = useRef<ScrollView>(null);
  const [opening] = useState(() => ({ x: revealedOffset(index, 0, viewport, T.card, STRIDE), y: 0 }));
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

  const overflowNoted = useRef(false);
  useEffect(() => {
    if (!visible || !overflows || overflowNoted.current) return;
    overflowNoted.current = true;
    noteTabSwitcherOverflowOpened();
  }, [visible, overflows]);

  useEffect(() => {
    const moved = shownIndex.current !== index;
    shownIndex.current = index;
    if (!placed.current) return;
    const next = revealedOffset(index, offset.current, viewport, T.card, STRIDE);
    if (Math.abs(next - offset.current) >= 0.5) scrollTo(next, moved);
  }, [index, viewport]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = e.nativeEvent.contentOffset.x;
    if (!visible || wheeled.current || performance.now() < ownScrollUntil.current) return;
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
        scrollTo(revealedOffset(shownIndex.current, offset.current, viewport, T.card, STRIDE), false);
      }}
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
        <View style={{ width: T.card, padding: T.cardInset, borderRadius: T.cardRadius, backgroundColor: focused ? colors.focusFill : undefined }}>
          <View
            style={{
              width: SHOT_WIDTH,
              height: SHOT,
              borderRadius: T.previewRadius,
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
                style={[StyleSheet.absoluteFill, { borderRadius: T.previewRadius, opacity: shown ? 1 : 0 }]}
              />
            )}
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                {
                  borderRadius: T.previewRadius,
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
