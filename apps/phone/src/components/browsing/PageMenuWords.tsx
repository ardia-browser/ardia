import { Children, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View, type ViewInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, FadeOut, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { copy } from "../../lib/platformCopy";
import { trayDragDismisses } from "../../lib/trayMotion";
import {
  canPrintPages,
  canSummarizePages,
  summarizeCurrentPage,
  closePageMenu,
  copyCurrentLink,
  editPageQuery,
  menuBack,
  menuForward,
  menuReload,
  menuStop,
  openInDefaultBrowser,
  openSiteSettingsSheet,
  pinCurrentToMac,
  printCurrentPage,
  resetZoom,
  sendCurrentTab,
  setBlockersOn,
  setDesktopSite,
  setNightShadeOn,
  shareCurrentPage,
  showFind,
  showReader,
  zoomIn,
  zoomOut,
} from "../../state/page/actions";
import type { MenuModel } from "../../state/page/pageMenu";
import { useMenuTitle, useTitleFeedback } from "../../state/page/hooks";
import { openLibrary, type LibrarySection } from "../../state/library/store";
import { useIsPinned, useSendTargets } from "../../state/sync/hooks";
import { useTab } from "../../state/tabs/hooks";
import { barCenterFromBottom, floatingBarLayout, font, MenuFrostProvider, pageMenuLayout, pageMenuMotion, PressScale, SheetScrollView, smoothCorners, space, SURFACES_FROST, Symbol, tabsCurve, Toggle, useCoverFocus, useReduceMotion, useTheme, type MenuItem, type SymbolName } from "../ui";
import { MenuMaterial } from "../ui/Menu";
import { MenuTrigger } from "../ui/MenuTrigger";
import { SheetScrollContext, sheetPullOffset, type SheetScroll } from "../ui/Sheet";
import { syncOffered } from "../../state/sync/offer";
import { usePageSummariesEnabled } from "../../state/pageSummary/enabled";
import { pageMenuCardInk, pageMenuCardMotion, pageMenuCards } from "./pageMenuTokens";

export const usePageMenuInk = () => pageMenuCardInk[useTheme().dark ? "dark" : "light"];

function openFromMenu(section: LibrarySection) {
  closePageMenu();
  openLibrary(section);
}

const useAccessibilityText = () => useWindowDimensions().fontScale >= copy().menuLargeTextScale;

const HIDE_FALLBACK_MS = 900;

export function pageMenuCardPlace(screen: { width: number; height: number }, insets: { top: number; bottom: number; left: number; right: number }) {
  const bottom = barCenterFromBottom(insets.bottom, "redesigned") + floatingBarLayout.control / 2 + pageMenuCards.aboveBar;
  const room = screen.width - insets.left - insets.right;
  const width = Math.min(room - 2 * pageMenuCards.side, pageMenuCards.maxWidth);
  return { left: insets.left + (room - width) / 2, width, bottom, maxHeight: Math.max(0, screen.height - insets.top - pageMenuCards.topGap - bottom) };
}

export function PageMenuCard({ open, onDismiss, onHidden, onTapAway, children }: { open: boolean; onDismiss: () => void; onHidden: () => void; onTapAway?: () => void; children: ReactNode }) {
  const ink = usePageMenuInk();
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const panel = useRef<ViewInstance>(null);
  useCoverFocus(panel);
  const shown = useSharedValue(0);
  const faded = useSharedValue(0);
  const drag = useSharedValue(0);
  const cardHeight = useSharedValue(screen.height);
  const atTop = useSharedValue(true);
  const scrolls = useSharedValue(false);
  const native = useMemo(() => Gesture.Native(), []);
  const scroll = useMemo<SheetScroll>(() => ({ native, atTop, scrolls }), [native]);
  useEffect(() => {
    if (open) {
      drag.value = 0;
      atTop.value = true;
      faded.value = withTiming(1, { duration: reduceMotion ? pageMenuCardMotion.reduced : pageMenuCardMotion.fadeIn, easing: tabsCurve.easeOut });
      shown.value = reduceMotion ? 1 : withSpring(1, pageMenuCardMotion.open);
      return;
    }
    const hidden = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(onHidden)();
    };
    if (!reduceMotion) shown.value = withSpring(0, pageMenuCardMotion.close);
    faded.value = withTiming(0, { duration: reduceMotion ? pageMenuCardMotion.reduced : pageMenuCardMotion.fadeOut, easing: tabsCurve.easeInOut }, hidden);
    const fallback = setTimeout(onHidden, HIDE_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [open]);
  const pull = Gesture.Pan()
    .withTestId("pageMenuCardDrag")
    .enabled(open)
    .activeOffsetY([-12, 12])
    .failOffsetX([-24, 24])
    .simultaneousWithExternalGesture(native)
    .onUpdate((event) => {
      drag.value = sheetPullOffset(event.translationY, scrolls.value, atTop.value);
    })
    .onEnd((event) => {
      if ((!scrolls.value || drag.value > 0) && trayDragDismisses(event.translationY, event.velocityY, cardHeight.value)) {
        runOnJS(onDismiss)();
        return;
      }
      drag.value = reduceMotion ? withTiming(0, { duration: pageMenuCardMotion.reduced, easing: tabsCurve.easeOut }) : withSpring(0, pageMenuCardMotion.open);
    });
  const scrim = useAnimatedStyle(() => ({ opacity: faded.value }));
  const lift = useAnimatedStyle(() => ({
    opacity: faded.value,
    transform: [{ translateY: (1 - shown.value) * pageMenuCardMotion.rise + drag.value }, { scale: pageMenuCardMotion.fromScale + (1 - pageMenuCardMotion.fromScale) * shown.value }],
  }));
  const place = pageMenuCardPlace(screen, insets);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? "box-none" : "none"} collapsable={false} importantForAccessibility={open ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!open}>
      <Animated.View style={[StyleSheet.absoluteFill, scrim]}>
        <Pressable
          testID="pageMenuScrim"
          accessibilityLabel="Close"
          style={[StyleSheet.absoluteFill, { backgroundColor: ink.scrim }]}
          onPress={() => {
            onTapAway?.();
            onDismiss();
          }}
        />
      </Animated.View>
      <GestureDetector gesture={pull}>
        <Animated.View
          ref={panel}
          testID="pageMenuCard"
          accessibilityViewIsModal
          onLayout={(event) => {
            cardHeight.value = event.nativeEvent.layout.height;
          }}
          style={[styles.cardPlace, { left: place.left, width: place.width, bottom: place.bottom, maxHeight: place.maxHeight, boxShadow: ink.shadow }, lift]}
        >
          <MenuMaterial source={SURFACES_FROST} fill={ink.tint} solid={ink.solid} radius={pageMenuCards.radius} style={[styles.cardMaterial, { maxHeight: place.maxHeight }]}>
            <SheetScrollContext.Provider value={scroll}>
              <MenuFrostProvider value={null}>{children}</MenuFrostProvider>
            </SheetScrollContext.Provider>
            <View testID="pageMenuCardRim" pointerEvents="none" style={[StyleSheet.absoluteFill, styles.cardRim, { borderColor: ink.rim }]} />
          </MenuMaterial>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

export function PageMenuWords({ tabId, model, onTranslate }: { tabId: string; model: MenuModel; onTranslate: () => void }) {
  const large = useAccessibilityText();
  const devices = useSendTargets(tabId);
  const offersSummary = usePageSummariesEnabled() && canSummarizePages();
  const [more, setMore] = useState(false);
  return (
    <SheetScrollView testID="pageMenuWords" style={styles.scroll} contentContainerStyle={[styles.column, large ? styles.largeBottom : null]} bounces={false}>
      <NavigationBar tabId={tabId} model={model} large={large} />
      <View style={styles.actions}>
        <ActionTile icon="docPlaintext" label="Reader" enabled={model.tiles} large={large} onPress={showReader} />
        <ActionTile icon="textMagnifyingglass" label="Find on Page" enabled={model.find} large={large} onPress={showFind} />
        <ActionTile icon="link" label="Copy Link" enabled={model.tiles} large={large} onPress={copyCurrentLink} />
        <ActionTile icon="squareAndArrowUp" label="Share" enabled={model.tiles} large={large} onPress={shareCurrentPage} />
      </View>
      <Group>
        {offersSummary ? <Row icon="sparkles" title="Summarize Page" enabled={model.summarize} onPress={summarizeCurrentPage} /> : null}
        {model.isWebPage && devices.length ? <SendRow devices={devices} /> : null}
        {model.pageRows ? (
          <ToggleRow icon={model.blockersEnabled ? "handRaised" : "handRaisedSlash"} title="Block Ads and Trackers" value={model.blockersEnabled} enabled={model.isWebPage} detail={model.blockedCount} onChange={setBlockersOn} />
        ) : null}
        {more ? null : <Row icon="ellipsis" title="More" enabled onPress={() => setMore(true)} />}
      </Group>
      {more ? (
        <>
          <Group>
            {model.pageRows ? <ToggleRow icon={model.nightShadeOn ? "moonFill" : "moon"} title="Night Shade" value={model.nightShadeOn} enabled={model.isWebPage} onChange={setNightShadeOn} /> : null}
            {model.pageRows ? <ZoomRow model={model} large={large} /> : null}
            {model.pageRows ? <ToggleRow icon="desktop" title="Desktop Site" value={model.desktopSite} enabled={model.isWebPage} onChange={setDesktopSite} /> : null}
            {model.pageRows ? <Row icon="translate" title={model.translateTitle} enabled={model.translate} onPress={onTranslate} /> : null}
            {canPrintPages() ? <Row icon="printer" title="Print" enabled={model.print} onPress={printCurrentPage} /> : null}
            <Row icon="gearshape" title="Site Settings" enabled onPress={openSiteSettingsSheet} />
          </Group>
          <Group>
            <Row icon="clockArrow" title="History" enabled onPress={() => openFromMenu("history")} />
            <Row icon="star" title="Bookmarks" enabled onPress={() => openFromMenu("bookmarks")} />
            <Row icon="arrowDownCircle" title="Downloads" enabled onPress={() => openFromMenu("downloads")} />
          </Group>
          {model.pageRows && model.offersDefaultBrowser ? (
            <Group>
              <Row icon="arrowUpForwardAppFill" title="Open in Default Browser" enabled onPress={openInDefaultBrowser} />
            </Group>
          ) : null}
        </>
      ) : null}
    </SheetScrollView>
  );
}

function NavigationBar({ tabId, model, large }: { tabId: string; model: MenuModel; large: boolean }) {
  const theme = useTheme();
  const ink = usePageMenuInk();
  const title = useMenuTitle(tabId);
  const feedback = useTitleFeedback();
  const shown = feedback ?? title;
  const titleButton = (
    <Pressable testID="pageMenuTitle" accessibilityRole="button" accessibilityLabel={shown} accessibilityHint="Edits the search" onPress={editPageQuery} style={large ? styles.titleBelow : styles.title}>
      <Animated.Text
        key={shown}
        entering={TITLE_IN}
        exiting={TITLE_OUT}
        style={[font.body, styles.titleText, large && !feedback ? styles.leading : styles.centered, feedback ? styles.feedback : null, { color: feedback ? theme.spaceAccentInk : theme.label }]}
        numberOfLines={large ? 3 : 1}
      >
        {shown}
      </Animated.Text>
    </Pressable>
  );
  return (
    <View testID="pageMenuCapsule" style={[styles.navigation, large ? styles.navigationTall : styles.navigationPill, { backgroundColor: ink.cell }]}>
      <View testID="pageMenuCapsuleRow" style={styles.navigationRow}>
        <BarButton icon="chevronLeft" label="Back" enabled={model.back} onPress={menuBack} />
        <BarButton icon="chevronRight" label="Forward" enabled={model.forward} onPress={menuForward} />
        {large ? <View style={styles.fill} /> : titleButton}
        {syncOffered() ? <PinButton tabId={tabId} enabled={model.isWebPage} /> : null}
        {model.reload === "stop" ? <BarButton icon="xmark" label="Stop" enabled onPress={menuStop} /> : <BarButton icon="arrowClockwise" label="Reload" enabled={model.reloadEnabled} onPress={menuReload} />}
      </View>
      {large ? <View style={[styles.navigationDivider, { backgroundColor: ink.separator }]} /> : null}
      {large ? titleButton : null}
    </View>
  );
}

function PinButton({ tabId, enabled }: { tabId: string; enabled: boolean }) {
  const tab = useTab(tabId);
  const pinned = useIsPinned(tabId);
  return <BarButton icon={pinned ? "starFill" : "star"} label={pinned ? "Pinned to Mac" : "Pin to Mac"} enabled={enabled && !tab?.isPrivate} onPress={pinCurrentToMac} />;
}

function BarButton({ icon, label, enabled, onPress }: { icon: SymbolName; label: string; enabled: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <PressScale label={label} disabled={!enabled} onPress={onPress} pressedScale={pageMenuLayout.pressedScale} pressSpring={pageMenuMotion.press} style={styles.barButton}>
      <Symbol name={icon} size={19} color={enabled ? theme.label : theme.tertiaryLabel} />
    </PressScale>
  );
}

function ActionTile({ icon, label, enabled, large, onPress }: { icon: SymbolName; label: string; enabled: boolean; large: boolean; onPress: () => void }) {
  const theme = useTheme();
  const ink = usePageMenuInk();
  return (
    <View testID={`pageMenuAction:${label}`} style={styles.action}>
      <PressScale label={label} disabled={!enabled} onPress={onPress} grow pressedScale={pageMenuLayout.pressedScale} pressSpring={pageMenuMotion.press} style={styles.actionPress}>
        <View style={[styles.tile, { backgroundColor: ink.cell }]}>
          <Symbol name={icon} size={pageMenuCards.tileGlyph} color={enabled ? theme.label : theme.tertiaryLabel} />
        </View>
        {large ? null : (
          <Text importantForAccessibility="no" accessibilityElementsHidden style={[font.caption, styles.medium, styles.centered, { color: enabled ? theme.secondaryLabel : theme.tertiaryLabel }]} numberOfLines={1}>
            {label}
          </Text>
        )}
      </PressScale>
    </View>
  );
}

function Group({ children }: { children: ReactNode }) {
  const ink = usePageMenuInk();
  const rows = Children.toArray(children);
  if (!rows.length) return null;
  return (
    <View testID="pageMenuGroup" style={[styles.group, { backgroundColor: ink.cell }]}>
      {rows.map((row, index) => (
        <View key={index}>
          {index > 0 ? <View style={[styles.divider, { backgroundColor: ink.separator }]} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

function RowIcon({ name, enabled }: { name: SymbolName; enabled: boolean }) {
  const theme = useTheme();
  return (
    <View style={styles.icon}>
      <Symbol name={name} size={pageMenuCards.rowGlyph} color={enabled ? theme.label : theme.tertiaryLabel} />
    </View>
  );
}

function Row({ icon, title, enabled, onPress }: { icon: SymbolName; title: string; enabled: boolean; onPress: () => void }) {
  const theme = useTheme();
  const ink = usePageMenuInk();
  return (
    <Pressable
      testID={`pageMenuRow:${title}`}
      accessibilityRole="button"
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed ? { backgroundColor: ink.rowPressed } : null]}
    >
      <RowIcon name={icon} enabled={enabled} />
      <Text style={[font.body, styles.rowTitle, { color: enabled ? theme.label : theme.tertiaryLabel }]}>{title}</Text>
    </Pressable>
  );
}

export function SendRow({ devices }: { devices: ReturnType<typeof useSendTargets> }) {
  const theme = useTheme();
  const ink = usePageMenuInk();
  if (devices.length === 1) return <Row icon="paperplane" title={`Send to ${devices[0]!.name}`} enabled onPress={() => sendCurrentTab(devices[0]!)} />;
  const items: MenuItem[] = devices.map((device) => ({ label: device.name, icon: device.kind === "mac" ? "laptop" : "iphone", systemImage: device.kind === "mac" ? "laptopcomputer" : "iphone", onPress: () => sendCurrentTab(device) }));
  return (
    <MenuTrigger items={items} trigger="tap" place={{ left: space.xxl, width: SEND_MENU_WIDTH }}>
      {({ onPress }) => (
        <Pressable testID="pageMenuRow:Send to Device" accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: ink.rowPressed } : null]}>
          <RowIcon name="paperplane" enabled />
          <Text style={[font.body, styles.rowTitle, { color: theme.label }]}>Send to Device</Text>
          <Symbol name="chevronUpChevronDown" size={14} color={theme.tertiaryLabel} />
        </Pressable>
      )}
    </MenuTrigger>
  );
}

function ToggleRow({ icon, title, value, enabled, detail, onChange }: { icon: SymbolName; title: string; value: boolean; enabled: boolean; detail?: string | null; onChange: (value: boolean) => void }) {
  const theme = useTheme();
  const flip = () => {
    if (enabled) onChange(!value);
  };
  const label = detail ? `${title}, Blocked ${detail}` : title;
  const content = (
    <>
      <RowIcon name={icon} enabled={enabled} />
      <Text style={[font.body, styles.rowTitle, { color: enabled ? theme.label : theme.tertiaryLabel }]}>{title}</Text>
      {detail ? <Text style={[font.subheadline, styles.digits, { color: theme.secondaryLabel }]}>{detail}</Text> : null}
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Toggle label={title} value={value} disabled={!enabled} onChange={onChange} />
      </View>
    </>
  );
  const switchRole = { accessible: true, accessibilityRole: "switch" as const, accessibilityLabel: label, accessibilityState: { checked: value, disabled: !enabled } };
  return copy().menuRowTogglesSwitch ? (
    <Pressable testID={`menuToggle:${title}`} {...switchRole} disabled={!enabled} onPress={flip} style={styles.row}>
      {content}
    </Pressable>
  ) : (
    <View testID={`menuToggle:${title}`} {...switchRole} onAccessibilityTap={flip} style={styles.row}>
      {content}
    </View>
  );
}

function ZoomRow({ model, large }: { model: MenuModel; large: boolean }) {
  const theme = useTheme();
  const ink = usePageMenuInk();
  const zoomButton = (icon: SymbolName, label: string, can: boolean, onPress: () => void) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={!can} onPress={onPress} hitSlop={ZOOM_SLOP} style={styles.zoomButton}>
      <Symbol name={icon} size={16} color={can ? theme.label : theme.tertiaryLabel} />
    </Pressable>
  );
  const heading = (
    <>
      <RowIcon name="textformatSize" enabled={model.isWebPage} />
      <Text style={[font.body, styles.rowTitle, { color: model.isWebPage ? theme.label : theme.tertiaryLabel }]}>Page Zoom</Text>
    </>
  );
  return (
    <View testID="menuZoom" style={large ? styles.zoomStacked : styles.row}>
      {large ? <View style={styles.zoomHeading}>{heading}</View> : heading}
      <View style={[styles.zoom, large ? styles.zoomIndented : null, { backgroundColor: ink.stepper }]}>
        {zoomButton("minus", "Zoom Out", model.zoomOut, zoomOut)}
        <Pressable accessibilityRole="button" accessibilityLabel="Reset Zoom" accessibilityValue={{ text: model.zoomPercent }} disabled={!model.isWebPage} onPress={resetZoom} hitSlop={ZOOM_SLOP} style={styles.zoomReset}>
          <Text style={[font.subheadline, styles.digits, styles.semibold, { color: theme.label }]}>{model.zoomPercent}</Text>
        </Pressable>
        {zoomButton("plus", "Zoom In", model.zoomIn, zoomIn)}
      </View>
    </View>
  );
}

const SEND_MENU_WIDTH = 250;
const ZOOM_SLOP = { top: (pageMenuCards.rowHeight - pageMenuCards.stepperHeight) / 2, bottom: (pageMenuCards.rowHeight - pageMenuCards.stepperHeight) / 2 };
const TITLE_IN = FadeIn.duration(pageMenuMotion.titleFade);
const TITLE_OUT = FadeOut.duration(pageMenuMotion.titleFade);
const LABEL_START = pageMenuCards.rowInset + pageMenuCards.iconSlot + pageMenuCards.iconGap;

const styles = StyleSheet.create({
  cardPlace: { position: "absolute", borderRadius: pageMenuCards.radius, ...smoothCorners },
  cardMaterial: { overflow: "hidden", borderRadius: pageMenuCards.radius, ...smoothCorners },
  cardRim: { borderRadius: pageMenuCards.radius, borderWidth: pageMenuCards.rim, ...smoothCorners },
  scroll: { flexGrow: 0, flexShrink: 1 },
  column: { padding: pageMenuCards.padding, gap: pageMenuCards.sectionGap },
  largeBottom: { paddingBottom: pageMenuCards.padding + pageMenuLayout.accessibilityBottom },
  navigation: { paddingHorizontal: space.xs, overflow: "hidden", ...smoothCorners },
  navigationPill: { borderRadius: pageMenuCards.barHeight / 2 },
  navigationTall: { borderRadius: pageMenuCards.groupRadius },
  navigationRow: { flexDirection: "row", alignItems: "center", minHeight: pageMenuCards.barHeight },
  barButton: { minWidth: pageMenuCards.barButton, minHeight: pageMenuCards.barHeight, alignItems: "center", justifyContent: "center" },
  navigationDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: pageMenuCards.rowInset },
  title: { flex: 1, paddingHorizontal: space.xs, justifyContent: "center", minHeight: pageMenuCards.barHeight },
  titleBelow: { paddingHorizontal: space.s, paddingVertical: space.m },
  titleText: { fontWeight: "600" },
  fill: { flex: 1 },
  centered: { textAlign: "center" },
  leading: { textAlign: "left" },
  feedback: { fontWeight: "600" },
  actions: { flexDirection: "row", gap: pageMenuCards.tileGap },
  action: { flex: 1 },
  actionPress: { gap: pageMenuCards.tileLabelGap, alignItems: "stretch" },
  tile: { aspectRatio: 1, borderRadius: pageMenuCards.tileRadius, ...smoothCorners, alignItems: "center", justifyContent: "center" },
  medium: { fontWeight: "500" },
  group: { borderRadius: pageMenuCards.groupRadius, ...smoothCorners, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: LABEL_START },
  row: { flexDirection: "row", alignItems: "center", minHeight: pageMenuCards.rowHeight, paddingHorizontal: pageMenuCards.rowInset, gap: pageMenuCards.iconGap },
  icon: { width: pageMenuCards.iconSlot, alignItems: "center" },
  rowTitle: { flex: 1, paddingVertical: space.s },
  digits: { fontVariant: ["tabular-nums"] },
  semibold: { fontWeight: "600" },
  zoom: { flexDirection: "row", alignItems: "center", overflow: "hidden", borderRadius: pageMenuCards.stepperRadius, ...smoothCorners },
  zoomStacked: { paddingHorizontal: pageMenuCards.rowInset, paddingVertical: space.m, gap: space.s, alignItems: "flex-start", minHeight: pageMenuCards.rowHeight },
  zoomHeading: { flexDirection: "row", alignItems: "center", gap: pageMenuCards.iconGap, alignSelf: "stretch" },
  zoomIndented: { marginLeft: pageMenuCards.iconSlot + pageMenuCards.iconGap },
  zoomButton: { width: pageMenuCards.stepperButton, height: pageMenuCards.stepperHeight, alignItems: "center", justifyContent: "center" },
  zoomReset: { minWidth: pageMenuCards.stepperReset, height: pageMenuCards.stepperHeight, alignItems: "center", justifyContent: "center" },
});
