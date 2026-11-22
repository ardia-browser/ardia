import { countUsage } from "../../state/telemetry/telemetry";
import { useEffect, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Pressable as GesturePressable } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { copy } from "../../lib/platformCopy";
import type { MaterialScheme } from "../../lib/material/schemes";
import {
  canPrintPages,
  canSummarizePages,
  printCurrentPage,
  closeMenuSubpage,
  closePageMenu,
  copyCurrentLink,
  editDockedPageQuery,
  editPageQuery,
  menuBack,
  menuForward,
  menuReload,
  menuStop,
  resetZoom,
  openInDefaultBrowser,
  pinCurrentToMac,
  sendCurrentTab,
  openSiteSettings,
  openSiteSettingsRoute,
  pageMenuHidden,
  setBlockersOn,
  setDesktopSite,
  setNightShadeOn,
  shareCurrentPage,
  showFind,
  showDockedFind,
  showReader,
  summarizeCurrentPage,
  translatePage,
  zoomIn,
  zoomOut,
} from "../../state/page/actions";
import { translationAsks, type MenuModel } from "../../state/page/pageMenu";
import { useMenuDocked, useMenuModel, useMenuPage, useMenuTitle, useTitleFeedback, useTranslationConfirmed } from "../../state/page/hooks";
import type { MenuPage } from "../../state/page/store";
import { SiteSettingsGroups } from "../settings/SitePages";
import { useIsPinned, useSendTargets } from "../../state/sync/hooks";
import { useSearchFromDockedMenu, useSearchOpen, useSearchSession } from "../../state/search/hooks";
import { cancelSearch } from "../../state/browse/store";
import { useTab } from "../../state/tabs/hooks";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { ConfirmDialog, settingsUIAvailable, FloatingMenu, font, MaterialIconButton, menuLayout, PressScale, shape, Sheet, smoothCorners, space, Symbol, tabsMotion, Toggle, useDesign, useTheme, type SymbolName } from "../ui";
import { MaterialPageMenu, MaterialPageMenuItems, MaterialSiteSettingsContent, MaterialSiteSettingsHeader } from "./MaterialPageMenu";
import { countSearchExpansion, MaterialSearchField, MaterialSearchResults, useMaterialSheetSearch } from "../search/MaterialSearchView";
import { barAddress } from "./FloatingBar";
import { PageMenuWords, usePageMenuInk } from "./PageMenuWords";
import { SystemPageMenu } from "./SystemPageMenu";
import { MaterialAddressContent } from "../ui/MaterialBottomBar";
import { useMaterialTheme } from "../ui/materialTheme";
import { MaterialSheet, useMaterialRipple } from "../ui/MaterialSurfaces";
import { materialBottomBar, materialShape, materialSize, materialType } from "../ui/materialTokens";
import { syncOffered } from "../../state/sync/offer";
import { usePageSummariesEnabled } from "../../state/pageSummary/enabled";

const PAGE_MENU_LIST_HEIGHT_RATIO = 0.52;
const countPageMenuExpansion = () => countUsage("site_settings_sheet_expanded");

export function PageMenu({ tabId, open, onHidden }: { tabId: string; open: boolean; onHidden: () => void }) {
  const model = useMenuModel(tabId);
  const [confirmsTranslation, setConfirmsTranslation] = useState(false);
  const tab = useTab(tabId);
  const isPrivate = tab?.isPrivate ?? false;
  const confirmed = useTranslationConfirmed();
  const translate = () => (translationAsks(isPrivate, confirmed) ? setConfirmsTranslation(true) : translatePage());
  const page = useMenuPage();
  const docked = useMenuDocked();
  const design = useDesign();
  const redesigned = design === "redesigned";
  const ink = usePageMenuInk();
  const hidden = () => {
    onHidden();
    pageMenuHidden();
  };
  const confirmation = confirmsTranslation ? (
    <ConfirmDialog
      confirmation={{ title: "Translate with Google?", message: "Google will see this page’s address.", action: "Translate", destructive: false, run: translatePage }}
      onClose={() => setConfirmsTranslation(false)}
    />
  ) : null;
  const tappedAway = isPrivate ? undefined : () => countUsage("page_menu_tapped_away");
  if (design === "material" && docked) {
    return <DockedPageMenu tabId={tabId} tab={tab} model={model} page={page} open={open} onHidden={hidden} onTranslate={translate}>{confirmation}</DockedPageMenu>;
  }
  if (redesigned && Platform.OS === "ios" && settingsUIAvailable()) {
    return <SystemPageMenu tabId={tabId} model={model} open={open} asksTranslation={confirmsTranslation} onAsksTranslationChange={setConfirmsTranslation} onTranslate={translate} onHidden={hidden} />;
  }
  if (redesigned) {
    return (
      <Sheet open={open} onDismiss={closePageMenu} onHidden={hidden} fill={ink.solid} onTapAway={tappedAway}>
        {confirmation}
        <PageMenuWords tabId={tabId} model={model} onTranslate={translate} />
      </Sheet>
    );
  }
  return (
    <Sheet open={open} onDismiss={closePageMenu} onBack={design === "material" && page === "siteSettings" ? closeMenuSubpage : undefined} onHidden={hidden} onTapAway={tappedAway}>
      {confirmation}
      {design === "material" ? (
        <MaterialPageMenu tabId={tabId} model={model} page={page} onTranslate={translate} />
      ) : (
        <LayoutAnimationConfig skipEntering>
          <Animated.View key={page} entering={FadeIn.duration(tabsMotion.surfaceFade)} exiting={FadeOut.duration(tabsMotion.surfaceFade)}>
            {page === "siteSettings" ? <MenuSiteSettings /> : <MenuMain tabId={tabId} model={model} onTranslate={translate} />}
          </Animated.View>
        </LayoutAnimationConfig>
      )}
    </Sheet>
  );
}

function DockedPageMenu({ tabId, tab, model, page, open, onHidden, onTranslate, children }: { tabId: string; tab: BrowserTab | null; model: MenuModel; page: MenuPage; open: boolean; onHidden: () => void; onTranslate: () => void; children: ReactNode }) {
  const { height } = useWindowDimensions();
  const { top, bottom } = useSafeAreaInsets();
  const { scheme } = useMaterialTheme(tab?.isPrivate);
  const scrollY = useSharedValue(0);
  const searchOpen = useSearchOpen();
  const searchFromMenu = useSearchFromDockedMenu();
  const session = useSearchSession();
  const startsSearch = Platform.OS === "android" && searchFromMenu && searchOpen;
  const [keepsSearch, setKeepsSearch] = useState(false);
  const searching = startsSearch || (!open && keepsSearch && searchFromMenu);
  const search = useMaterialSheetSearch(searching);
  useEffect(() => {
    if (startsSearch || open) setKeepsSearch(startsSearch);
  }, [startsSearch, open]);
  useEffect(() => {
    scrollY.value = 0;
  }, [page, searching, scrollY]);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const listHeight = Math.max(0, (height - top - bottom) * PAGE_MENU_LIST_HEIGHT_RATIO);
  const addressHeight = tab ? materialBottomBar.field + materialBottomBar.inset : 0;
  const compactMaxHeight = listHeight + materialSize.touchTarget + addressHeight + bottom;
  return (
    <MaterialSheet
      open={searching ? searchOpen : open}
      onDismiss={searching ? cancelSearch : closePageMenu}
      onBack={!searching && page === "siteSettings" ? closeMenuSubpage : undefined}
      onHidden={onHidden}
      search={searching ? search : undefined}
      expandableList={{ scrollY, compactMaxHeight, onExpand: searching ? countSearchExpansion : tab?.isPrivate ? undefined : countPageMenuExpansion }}
      dockedBar={tab ? (spread) => searching ? <MaterialSearchField key={session} open={searchOpen} dockedMenu spread={spread} /> : <DockedMainPageMenuBar tab={tab} model={model} spread={spread} /> : undefined}
      dockedBarReserved={searching || page !== "siteSettings"}
      dockedBarColor={!searching && page !== "siteSettings" ? scheme.surfaceContainerHigh : undefined}
    >
      {children}
      {searching ? <MaterialSearchResults key={session} scrollY={scrollY} /> : page === "siteSettings" ? (
        <>
          <MaterialSiteSettingsHeader onBack={closeMenuSubpage} />
          <Animated.ScrollView key="siteSettings" testID="dockedPageMenuSiteSettings" onScroll={onScroll} scrollEventThrottle={16} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.dockedMenuItems} bounces={false}>
            <MaterialSiteSettingsContent />
          </Animated.ScrollView>
        </>
      ) : (
        <Animated.ScrollView key="main" testID="dockedPageMenuList" onScroll={onScroll} scrollEventThrottle={16} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.dockedMenuItems} bounces={false}>
          <MaterialPageMenuItems tabId={tabId} model={model} onTranslate={onTranslate} onFind={showDockedFind} />
        </Animated.ScrollView>
      )}
    </MaterialSheet>
  );
}

const DOCKED_BUTTON = materialSize.iconButton;

function DockedMainPageMenuBar({ tab, model, spread }: { tab: BrowserTab; model: MenuModel; spread: SharedValue<number> }) {
  const { scheme } = useMaterialTheme(tab.isPrivate);
  const ripple = useMaterialRipple(true);
  const address = barAddress(tab);
  const title = useMenuTitle(tab.id);
  const feedback = useTitleFeedback();
  const pinned = useIsPinned(tab.id);
  const labelColor = scheme.onSurface;
  const iconColor = scheme.onSurfaceVariant;
  const barStyle = useAnimatedStyle(() => ({ paddingLeft: 4 * spread.value }));
  const navStyle = useAnimatedStyle(() => ({ width: DOCKED_BUTTON * 2 * spread.value, opacity: Math.max(0, 2 * spread.value - 1) }));
  const pinStyle = useAnimatedStyle(() => ({ width: DOCKED_BUTTON * spread.value, opacity: Math.max(0, 2 * spread.value - 1) }));
  const reloadSlotStyle = useAnimatedStyle(() => ({ width: materialSize.touchTarget - (materialSize.touchTarget - DOCKED_BUTTON) * spread.value }));
  const expandedStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, 2 * spread.value - 1) }));
  const collapsedStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - 2 * spread.value) }));
  const reloadStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, 2 * spread.value - 1) }));
  const dotsStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - 2 * spread.value) }));
  return (
    <Animated.View testID="dockedPageMenuBar" style={[styles.siteAddressBar, barStyle]}>
      <Animated.View pointerEvents="none" importantForAccessibility="no-hide-descendants" style={[styles.siteAddressContent, collapsedStyle]}>
        <MaterialAddressContent address={address} scheme={scheme} testID="siteSettingsAddressHost" />
      </Animated.View>
      <Animated.View testID="dockedPageMenuHistory" style={[styles.siteNavGroup, navStyle]}>
        <DockedMenuButton id="siteSettingsBack" label="Back" icon="chevronLeft" scheme={scheme} enabled={model.back} onPress={menuBack} />
        <DockedMenuButton id="siteSettingsForward" label="Forward" icon="chevronRight" scheme={scheme} enabled={model.forward} onPress={menuForward} />
      </Animated.View>
      <View style={styles.dockedTitleSlot}>
        <Animated.View testID="dockedPageMenuTitleSlot" style={[StyleSheet.absoluteFill, expandedStyle]}>
          <GesturePressable testID="dockedPageMenuTitle" accessibilityRole="button" accessibilityLabel={feedback ?? title} accessibilityHint="Edits the search" android_ripple={ripple} onPress={Platform.OS === "android" ? editDockedPageQuery : editPageQuery} style={styles.dockedTitleButton}>
            <Text numberOfLines={1} ellipsizeMode="tail" style={[materialType.bodyLarge, styles.centered, { color: feedback && !address.isPrivate ? scheme.primary : labelColor }]}>{feedback ?? title}</Text>
          </GesturePressable>
        </Animated.View>
      </View>
      {syncOffered() ? (
        <Animated.View style={[styles.siteNavSlot, styles.siteHiddenNav, pinStyle]}>
          <DockedMenuButton id="dockedPageMenuPin" label={pinned ? "Pinned to Mac" : "Pin to Mac"} icon={pinned ? "starFill" : "star"} scheme={scheme} enabled={model.isWebPage && !tab.isPrivate} selected={pinned} onPress={pinCurrentToMac} />
        </Animated.View>
      ) : null}
      <Animated.View style={[styles.siteNavSlot, reloadSlotStyle]}>
        <Animated.View pointerEvents="none" importantForAccessibility="no-hide-descendants" style={[styles.siteAddressDots, dotsStyle]}>
          <Symbol name="ellipsis" size={20} color={iconColor} />
        </Animated.View>
        <Animated.View style={reloadStyle}>
          {model.reload === "stop" ? (
            <DockedMenuButton id="dockedPageMenuReload" label="Stop" icon="xmark" scheme={scheme} enabled onPress={menuStop} />
          ) : (
            <DockedMenuButton id="dockedPageMenuReload" label="Reload" icon="arrowClockwise" scheme={scheme} enabled={model.reloadEnabled} onPress={menuReload} />
          )}
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}

function DockedMenuButton({ id, label, icon, scheme, enabled, selected, onPress }: { id: string; label: string; icon: SymbolName; scheme: MaterialScheme; enabled: boolean; selected?: boolean; onPress: () => void }) {
  return <MaterialIconButton testID={id} label={label} icon={icon} scheme={scheme} size="narrow" enabled={enabled} selected={selected} onPress={onPress} />;
}

function MenuMain({ tabId, model, onTranslate }: { tabId: string; model: MenuModel; onTranslate: () => void }) {
  const { fontScale } = useWindowDimensions();
  const large = fontScale >= copy().menuLargeTextScale;
  const offersSummary = usePageSummariesEnabled() && canSummarizePages();
  return (
    <ScrollView contentContainerStyle={styles.column} bounces={false}>
      <NavigationCapsule tabId={tabId} />
      {large ? (
        <Group>
          <Row icon="docPlaintext" title="Reader" enabled={model.tiles} onPress={showReader} />
          <Row icon="link" title="Copy Link" enabled={model.tiles} onPress={copyCurrentLink} />
          <Row icon="squareAndArrowUp" title="Share" enabled={model.tiles} divider={false} onPress={shareCurrentPage} />
        </Group>
      ) : (
        <View style={styles.tiles}>
          <Tile icon="docPlaintext" title="Reader" enabled={model.tiles} onPress={showReader} />
          <Tile icon="link" title="Copy Link" enabled={model.tiles} onPress={copyCurrentLink} />
          <Tile icon="squareAndArrowUp" title="Share" enabled={model.tiles} onPress={shareCurrentPage} />
        </View>
      )}
      <Group>
        <Row icon="textMagnifyingglass" title="Find on Page" enabled={model.find} divider={offersSummary || model.pageRows} onPress={showFind} />
        {offersSummary ? <Row icon="sparkles" title="Summarize Page" enabled={model.summarize} divider={model.pageRows} onPress={summarizeCurrentPage} /> : null}
        {model.pageRows ? <SendRow tabId={tabId} enabled={model.isWebPage} /> : null}
        {model.pageRows ? <Row icon="translate" title={model.translateTitle} enabled={model.translate} divider={canPrintPages()} onPress={onTranslate} /> : null}
        {model.pageRows && canPrintPages() ? <Row icon="printer" title="Print" enabled={model.print} divider={false} onPress={printCurrentPage} /> : null}
      </Group>
      {model.pageRows ? (
        <>
          <Group>
            <ToggleRow
              icon={model.nightShadeOn ? "moonFill" : "moon"}
              title="Night Shade"
              value={model.nightShadeOn}
              enabled={model.isWebPage}
              onChange={setNightShadeOn}
            />
            <ZoomRow percent={model.zoomPercent} canZoomOut={model.zoomOut} canZoomIn={model.zoomIn} enabled={model.isWebPage} stacked={large} />
            <ToggleRow icon="desktop" title="Desktop Site" value={model.desktopSite} enabled={model.isWebPage} divider={false} onChange={setDesktopSite} />
          </Group>
          <Group>
            <ToggleRow
              icon={model.blockersEnabled ? "handRaised" : "handRaisedSlash"}
              title="Block Ads and Trackers"
              value={model.blockersEnabled}
              enabled={model.isWebPage}
              detail={model.blockedCount}
              onChange={setBlockersOn}
            />
            <Row icon="gearshape" title="Site Settings" enabled divider={model.offersDefaultBrowser} onPress={openSiteSettings} />
            {model.offersDefaultBrowser ? (
              <Row icon="safariFill" title="Open in Default Browser" enabled divider={false} onPress={openInDefaultBrowser} />
            ) : null}
          </Group>
        </>
      ) : null}
    </ScrollView>
  );
}

function MenuSiteSettings() {
  const theme = useTheme();
  return (
    <ScrollView contentContainerStyle={styles.subpage} bounces={false}>
      <View style={styles.subpageBar}>
        <CapsuleButton icon="chevronLeft" label="Back" enabled onPress={closeMenuSubpage} />
        <Text accessibilityRole="header" style={[font.body, styles.subpageTitle, { color: theme.label }]} numberOfLines={1}>
          Site Settings
        </Text>
        <View style={styles.subpageBalance} />
      </View>
      <SiteSettingsGroups openRoute={openSiteSettingsRoute} />
    </ScrollView>
  );
}

function NavigationCapsule({ tabId }: { tabId: string }) {
  const theme = useTheme();
  const model = useMenuModel(tabId);
  const title = useMenuTitle(tabId);
  const feedback = useTitleFeedback();
  const { fontScale } = useWindowDimensions();
  const below = copy().menuTitleBelowAtLargeText && fontScale > ACCESSIBILITY_TEXT;
  const shown = feedback ?? title;
  const titleButton = (
    <Pressable accessibilityRole="button" accessibilityLabel={shown} accessibilityHint="Edits the search" onPress={editPageQuery} style={below ? styles.titleBelow : styles.title}>
      <Animated.Text
        key={shown}
        entering={TITLE_IN}
        exiting={TITLE_OUT}
        style={[font.body, styles.centered, feedback ? styles.feedback : null, { color: feedback ? theme.spaceAccentInk : theme.label }]}
        numberOfLines={below ? 3 : 1}
      >
        {shown}
      </Animated.Text>
    </Pressable>
  );
  return (
    <>
      <View style={[styles.capsule, { backgroundColor: theme.groupFill }]}>
        <CapsuleButton icon="chevronLeft" label="Back" enabled={model.back} onPress={menuBack} />
        <CapsuleButton icon="chevronRight" label="Forward" enabled={model.forward} onPress={menuForward} />
        {below ? <View style={styles.fill} /> : titleButton}
        {syncOffered() ? <PinButton tabId={tabId} enabled={model.isWebPage} /> : null}
        {model.reload === "stop" ? (
          <CapsuleButton icon="xmark" label="Stop" enabled onPress={menuStop} />
        ) : (
          <CapsuleButton icon="arrowClockwise" label="Reload" enabled={model.reloadEnabled} onPress={menuReload} />
        )}
      </View>
      {below ? titleButton : null}
    </>
  );
}

function PinButton({ tabId, enabled }: { tabId: string; enabled: boolean }) {
  const theme = useTheme();
  const tab = useTab(tabId);
  const pinned = useIsPinned(tabId);
  const can = enabled && !tab?.isPrivate;
  return (
    <PressScale label={pinned ? "Pinned to Mac" : "Pin to Mac"} disabled={!can} onPress={pinCurrentToMac} style={styles.capsuleButton}>
      <Symbol name={pinned ? "starFill" : "star"} size={19} color={can ? theme.label : theme.tertiaryLabel} />
    </PressScale>
  );
}

function SendRow({ tabId, enabled }: { tabId: string; enabled: boolean }) {
  const devices = useSendTargets(tabId);
  const [menuAt, setMenuAt] = useState<number | null>(null);
  if (!enabled || !devices.length) return null;
  if (devices.length === 1) return <Row icon="paperplane" title={`Send to ${devices[0]!.name}`} enabled onPress={() => sendCurrentTab(devices[0]!)} />;
  return (
    <>
      <RowWithEvent icon="paperplane" title="Send to Device" onPress={(y) => setMenuAt(y)} />
      {menuAt !== null ? (
        <FloatingMenu
          items={devices.map((device) => ({ label: device.name, icon: device.kind === "mac" ? "laptop" : "iphone", onPress: () => sendCurrentTab(device) }))}
          place={{ top: menuAt, left: space.xxl, width: 250 }}
          onDismiss={() => setMenuAt(null)}
        />
      ) : null}
    </>
  );
}

function RowWithEvent({ icon, title, onPress }: { icon: SymbolName; title: string; onPress: (y: number) => void }) {
  const theme = useTheme();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        onPress={(event) => onPress(event.nativeEvent.pageY)}
        style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}
      >
        <View style={styles.icon}>
          <Symbol name={icon} size={20} color={theme.secondaryLabel} />
        </View>
        <Text style={[font.body, styles.rowTitle, { color: theme.label }]}>{title}</Text>
        <Symbol name="chevronDown" size={14} color={theme.tertiaryLabel} />
      </Pressable>
      <Divider />
    </View>
  );
}

function CapsuleButton({ icon, label, enabled, onPress }: { icon: SymbolName; label: string; enabled: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <PressScale label={label} disabled={!enabled} onPress={onPress} style={styles.capsuleButton}>
      <Symbol name={icon} size={19} color={enabled ? theme.label : theme.tertiaryLabel} />
    </PressScale>
  );
}

function Tile({ icon, title, enabled, onPress }: { icon: SymbolName; title: string; enabled: boolean; onPress: () => void }) {
  const theme = useTheme();
  const ink = enabled ? theme.label : theme.tertiaryLabel;
  return (
    <PressScale label={title} disabled={!enabled} onPress={onPress} grow style={[styles.tile, { backgroundColor: theme.groupFill }]}>
      <Symbol name={icon} size={22} color={ink} />
      <Text style={[font.footnote, styles.medium, { color: ink }]} numberOfLines={1}>
        {title}
      </Text>
    </PressScale>
  );
}

function Group({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <View style={[styles.group, { backgroundColor: theme.groupFill }]}>{children}</View>;
}

function Divider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.separator }]} />;
}

type RowProps = { icon: SymbolName; title: string; enabled: boolean; divider?: boolean; onPress: () => void };

function Row({ icon, title, enabled, divider = true, onPress }: RowProps) {
  const theme = useTheme();
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !enabled }}
        disabled={!enabled}
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.rowHighlight } : null]}
      >
        <View style={styles.icon}>
          <Symbol name={icon} size={20} color={theme.secondaryLabel} />
        </View>
        <Text style={[font.body, styles.rowTitle, { color: enabled ? theme.label : theme.tertiaryLabel }]}>{title}</Text>
      </Pressable>
      {divider ? <Divider /> : null}
    </View>
  );
}

type ToggleRowProps = { icon: SymbolName; title: string; value: boolean; enabled: boolean; detail?: string | null; divider?: boolean; onChange: (value: boolean) => void };

function ToggleRow({ icon, title, value, enabled, detail, divider = true, onChange }: ToggleRowProps) {
  const theme = useTheme();
  const flip = () => {
    if (enabled) onChange(!value);
  };
  const label = detail ? `${title}, Blocked ${detail}` : title;
  const content = (
    <>
      <View style={styles.icon}>
        <Symbol name={icon} size={20} color={theme.secondaryLabel} />
      </View>
      <Text style={[font.body, styles.rowTitle, { color: enabled ? theme.label : theme.tertiaryLabel }]}>{title}</Text>
      {detail ? <Text style={[font.subheadline, styles.digits, { color: theme.secondaryLabel }]}>{detail}</Text> : null}
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Toggle label={title} value={value} disabled={!enabled} onChange={onChange} />
      </View>
    </>
  );
  const switchRole = { accessible: true, accessibilityRole: "switch" as const, accessibilityLabel: label, accessibilityState: { checked: value, disabled: !enabled } };
  return (
    <View>
      {copy().menuRowTogglesSwitch ? (
        <Pressable testID={`menuToggle:${title}`} {...switchRole} disabled={!enabled} onPress={flip} style={styles.row}>
          {content}
        </Pressable>
      ) : (
        <View testID={`menuToggle:${title}`} {...switchRole} onAccessibilityTap={flip} style={styles.row}>
          {content}
        </View>
      )}
      {divider ? <Divider /> : null}
    </View>
  );
}

function ZoomRow({ percent, canZoomOut, canZoomIn, enabled, stacked }: { percent: string; canZoomOut: boolean; canZoomIn: boolean; enabled: boolean; stacked: boolean }) {
  const theme = useTheme();
  const zoomButton = (icon: SymbolName, label: string, can: boolean, onPress: () => void) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={!can} onPress={onPress} style={styles.zoomButton}>
      <Symbol name={icon} size={16} color={can ? theme.label : theme.tertiaryLabel} />
    </Pressable>
  );
  const heading = (
    <>
      <View style={styles.icon}>
        <Symbol name="textformatSize" size={20} color={theme.secondaryLabel} />
      </View>
      <Text style={[font.body, styles.rowTitle, { color: enabled ? theme.label : theme.tertiaryLabel }]}>Page Zoom</Text>
    </>
  );
  return (
    <View>
      <View testID="menuZoom" style={stacked ? styles.zoomStacked : styles.row}>
        {stacked ? <View style={styles.zoomHeading}>{heading}</View> : heading}
        <View style={[styles.zoom, { backgroundColor: theme.tertiaryFill }]}>
          {zoomButton("minus", "Zoom Out", canZoomOut, zoomOut)}
          <Pressable accessibilityRole="button" accessibilityLabel="Reset Zoom" accessibilityValue={{ text: percent }} disabled={!enabled} onPress={resetZoom} style={styles.zoomReset}>
            <Text style={[font.subheadline, styles.digits, styles.medium, { color: theme.label }]}>{percent}</Text>
          </Pressable>
          {zoomButton("plus", "Zoom In", canZoomIn, zoomIn)}
        </View>
      </View>
      <Divider />
    </View>
  );
}

const ACCESSIBILITY_TEXT = 1.6;
const TITLE_IN = FadeIn.duration(tabsMotion.fade);
const TITLE_OUT = FadeOut.duration(tabsMotion.fade);

const styles = StyleSheet.create({
  siteAddressBar: { flex: 1, flexDirection: "row", alignItems: "center", borderRadius: materialShape.full, paddingRight: 4, overflow: "hidden" },
  dockedTitleSlot: { flex: 1, minWidth: 0, height: "100%" },
  dockedTitleButton: { flex: 1, justifyContent: "center", paddingHorizontal: 4 },
  dockedMenuItems: { paddingBottom: 16 },
  siteAddressContent: { ...StyleSheet.absoluteFill, right: materialSize.touchTarget, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12 },
  siteNavGroup: { width: 0, opacity: 0, flexDirection: "row", height: materialSize.touchTarget, overflow: "hidden" },
  siteHiddenNav: { width: 0, opacity: 0 },
  siteNavSlot: { width: materialSize.touchTarget, height: materialSize.touchTarget, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  siteAddressDots: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", transform: [{ rotate: "90deg" }] },
  column: { padding: menuLayout.inset, gap: menuLayout.inset },
  subpage: { paddingVertical: menuLayout.inset, gap: space.l },
  subpageBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.tight },
  subpageTitle: { flex: 1, textAlign: "center", fontWeight: "600" },
  subpageBalance: { width: 44 },
  capsule: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: menuLayout.capsuleHeight,
    borderRadius: shape.card,
    ...smoothCorners,
    paddingHorizontal: space.xs,
  },
  capsuleButton: { minWidth: 44, minHeight: menuLayout.capsuleHeight, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, paddingHorizontal: space.xs, justifyContent: "center", minHeight: menuLayout.capsuleHeight },
  titleBelow: { paddingHorizontal: space.l, paddingTop: space.s, justifyContent: "center" },
  fill: { flex: 1 },
  centered: { textAlign: "center" },
  feedback: { fontWeight: "600" },
  tiles: { flexDirection: "row", gap: space.s },
  tile: {
    minHeight: menuLayout.tileHeight,
    borderRadius: shape.card,
    ...smoothCorners,
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs + 2,
    paddingVertical: space.m,
  },
  medium: { fontWeight: "500" },
  group: { borderRadius: shape.card, ...smoothCorners, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", minHeight: menuLayout.rowHeight, paddingHorizontal: space.l, gap: space.m },
  icon: { width: menuLayout.iconSlot, alignItems: "center" },
  rowTitle: { flex: 1, paddingVertical: space.s },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: space.l + menuLayout.iconSlot + space.m },
  digits: { fontVariant: ["tabular-nums"] },
  zoom: { flexDirection: "row", alignItems: "center", overflow: "hidden", borderRadius: shape.control, ...smoothCorners },
  zoomStacked: { paddingHorizontal: space.l, paddingVertical: space.m, gap: space.s, alignItems: "flex-start" },
  zoomHeading: { flexDirection: "row", alignItems: "center", gap: space.m, alignSelf: "stretch" },
  zoomButton: { width: menuLayout.zoomButton.width, height: menuLayout.zoomButton.height, alignItems: "center", justifyContent: "center" },
  zoomReset: { minWidth: menuLayout.zoomReset, height: menuLayout.zoomButton.height, alignItems: "center", justifyContent: "center" },
});
