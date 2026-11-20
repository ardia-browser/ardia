import { Children, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { copy } from "../../lib/platformCopy";
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
import { capsule, ChromeSurface, font, menuLayout, pageMenuInk, pageMenuLayout, pageMenuMotion, PressScale, SheetScrollView, space, Symbol, Toggle, useTheme, type MenuItem, type SymbolName } from "../ui";
import { MenuTrigger } from "../ui/MenuTrigger";
import { syncOffered } from "../../state/sync/offer";

export const usePageMenuInk = () => pageMenuInk[useTheme().dark ? "dark" : "light"];

const LIBRARY_ROWS = Platform.OS === "ios";

function openFromMenu(section: LibrarySection) {
  closePageMenu();
  openLibrary(section);
}

const useAccessibilityText = () => useWindowDimensions().fontScale >= copy().menuLargeTextScale;

export function PageMenuWords({ tabId, model, onTranslate }: { tabId: string; model: MenuModel; onTranslate: () => void }) {
  const large = useAccessibilityText();
  const devices = useSendTargets(tabId);
  return (
    <SheetScrollView testID="pageMenuWords" contentContainerStyle={[styles.column, large ? styles.largeBottom : null]} bounces={false}>
      <View style={styles.bar}>
        <NavigationCapsule tabId={tabId} model={model} large={large} />
        <View style={styles.actions}>
          <ActionCapsule icon="docPlaintext" label="Reader" enabled={model.tiles} onPress={showReader} />
          <ActionCapsule icon="link" label="Copy Link" enabled={model.tiles} onPress={copyCurrentLink} />
          <ActionCapsule icon="squareAndArrowUp" label="Share" enabled={model.tiles} onPress={shareCurrentPage} />
        </View>
      </View>
      <View style={styles.groups}>
        <Group>
          <Row title="Find on Page" enabled={model.find} onPress={showFind} />
          {canSummarizePages() ? <Row title="Summarize Page" enabled={model.summarize} onPress={summarizeCurrentPage} /> : null}
          {model.isWebPage && devices.length ? <SendRow devices={devices} /> : null}
          {canPrintPages() ? <Row title="Print" enabled={model.print} onPress={printCurrentPage} /> : null}
        </Group>
        {LIBRARY_ROWS ? (
          <Group>
            <Row title="History" enabled onPress={() => openFromMenu("history")} />
            <Row title="Bookmarks" enabled onPress={() => openFromMenu("bookmarks")} />
            <Row title="Downloads" enabled onPress={() => openFromMenu("downloads")} />
          </Group>
        ) : null}
        <Group>
          {model.pageRows ? <ToggleRow title="Night Shade" value={model.nightShadeOn} enabled={model.isWebPage} onChange={setNightShadeOn} /> : null}
          {model.pageRows ? <ZoomRow model={model} large={large} /> : null}
          {model.pageRows ? <ToggleRow title="Desktop Site" value={model.desktopSite} enabled={model.isWebPage} onChange={setDesktopSite} /> : null}
          {model.pageRows ? <Row title={model.translateTitle} enabled={model.translate} onPress={onTranslate} /> : null}
          {model.pageRows ? (
            <ToggleRow title="Block Ads and Trackers" value={model.blockersEnabled} enabled={model.isWebPage} detail={model.blockedCount} onChange={setBlockersOn} />
          ) : null}
          <Row title="Site Settings" enabled onPress={openSiteSettingsSheet} />
        </Group>
        {model.pageRows && model.offersDefaultBrowser ? (
          <Group>
            <Row title="Open in Default Browser" enabled onPress={openInDefaultBrowser} />
          </Group>
        ) : null}
      </View>
    </SheetScrollView>
  );
}

function NavigationCapsule({ tabId, model, large }: { tabId: string; model: MenuModel; large: boolean }) {
  const theme = useTheme();
  const title = useMenuTitle(tabId);
  const feedback = useTitleFeedback();
  const shown = feedback ?? title;
  const titleButton = (
    <Pressable
      testID="pageMenuTitle"
      accessibilityRole="button"
      accessibilityLabel={shown}
      accessibilityHint="Edits the search"
      onPress={editPageQuery}
      style={large ? styles.titleBelow : styles.title}
    >
      <Animated.Text
        key={shown}
        entering={TITLE_IN}
        exiting={TITLE_OUT}
        style={[font.body, large && !feedback ? styles.leading : styles.centered, feedback ? styles.feedback : null, { color: feedback ? theme.formAccent : theme.label }]}
        numberOfLines={large ? 3 : 1}
      >
        {shown}
      </Animated.Text>
    </Pressable>
  );
  const radius = large ? menuLayout.innerRadius : capsule(menuLayout.capsuleHeight);
  return (
    <ChromeSurface testID="pageMenuCapsule" shape={large ? "rounded" : "capsule"} cornerRadius={radius} interactive={false} style={styles.capsule}>
      <View testID="pageMenuCapsuleRow" style={styles.capsuleRow}>
        <CapsuleButton icon="chevronLeft" label="Back" enabled={model.back} onPress={menuBack} />
        <CapsuleButton icon="chevronRight" label="Forward" enabled={model.forward} onPress={menuForward} />
        {large ? <View style={styles.fill} /> : titleButton}
        {syncOffered() ? <PinButton tabId={tabId} enabled={model.isWebPage} /> : null}
        {model.reload === "stop" ? (
          <CapsuleButton icon="xmark" label="Stop" enabled onPress={menuStop} />
        ) : (
          <CapsuleButton icon="arrowClockwise" label="Reload" enabled={model.reloadEnabled} onPress={menuReload} />
        )}
      </View>
      {large ? <View style={[styles.capsuleDivider, { backgroundColor: theme.separator }]} /> : null}
      {large ? titleButton : null}
    </ChromeSurface>
  );
}

function PinButton({ tabId, enabled }: { tabId: string; enabled: boolean }) {
  const tab = useTab(tabId);
  const pinned = useIsPinned(tabId);
  return <CapsuleButton icon={pinned ? "starFill" : "star"} label={pinned ? "Pinned to Mac" : "Pin to Mac"} enabled={enabled && !tab?.isPrivate} onPress={pinCurrentToMac} />;
}

function CapsuleButton({ icon, label, enabled, onPress }: { icon: SymbolName; label: string; enabled: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <PressScale label={label} disabled={!enabled} onPress={onPress} pressedScale={pageMenuLayout.pressedScale} pressSpring={pageMenuMotion.press} style={styles.capsuleButton}>
      <Symbol name={icon} size={19} color={enabled ? theme.label : theme.tertiaryLabel} />
    </PressScale>
  );
}

function ActionCapsule({ icon, label, enabled, onPress }: { icon: SymbolName; label: string; enabled: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <ChromeSurface testID={`pageMenuAction:${label}`} shape="capsule" cornerRadius={capsule(menuLayout.capsuleHeight)} style={styles.action}>
      <PressScale label={label} disabled={!enabled} onPress={onPress} grow pressedScale={pageMenuLayout.pressedScale} pressSpring={pageMenuMotion.press} style={styles.actionHit}>
        <Symbol name={icon} size={pageMenuLayout.actionGlyph} color={enabled ? theme.label : theme.tertiaryLabel} />
      </PressScale>
    </ChromeSurface>
  );
}

function Group({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const ink = usePageMenuInk();
  const rows = Children.toArray(children);
  if (!rows.length) return null;
  return (
    <View testID="pageMenuGroup" style={[styles.group, { backgroundColor: ink.group }]}>
      {rows.map((row, index) => (
        <View key={index}>
          {index > 0 ? <View style={[styles.divider, { backgroundColor: theme.separator }]} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

function Row({ title, enabled, onPress }: { title: string; enabled: boolean; onPress: () => void }) {
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
      <Text style={[font.callout, styles.rowTitle, { color: enabled ? theme.label : theme.tertiaryLabel }]}>{title}</Text>
    </Pressable>
  );
}

export function SendRow({ devices }: { devices: ReturnType<typeof useSendTargets> }) {
  const theme = useTheme();
  const ink = usePageMenuInk();
  if (devices.length === 1) return <Row title={`Send to ${devices[0]!.name}`} enabled onPress={() => sendCurrentTab(devices[0]!)} />;
  const items: MenuItem[] = devices.map((device) => ({ label: device.name, icon: device.kind === "mac" ? "laptop" : "iphone", systemImage: device.kind === "mac" ? "laptopcomputer" : "iphone", onPress: () => sendCurrentTab(device) }));
  return (
    <MenuTrigger items={items} trigger="tap" place={{ left: space.xxl, width: SEND_MENU_WIDTH }}>
      {({ onPress }) => (
        <Pressable
          testID="pageMenuRow:Send to Device"
          accessibilityRole="button"
          onPress={onPress}
          style={({ pressed }) => [styles.row, pressed ? { backgroundColor: ink.rowPressed } : null]}
        >
          <Text style={[font.callout, styles.rowTitle, { color: theme.label }]}>Send to Device</Text>
          <Symbol name="chevronUpChevronDown" size={14} color={theme.tertiaryLabel} />
        </Pressable>
      )}
    </MenuTrigger>
  );
}

function ToggleRow({ title, value, enabled, detail, onChange }: { title: string; value: boolean; enabled: boolean; detail?: string | null; onChange: (value: boolean) => void }) {
  const theme = useTheme();
  const flip = () => {
    if (enabled) onChange(!value);
  };
  const label = detail ? `${title}, Blocked ${detail}` : title;
  const content = (
    <>
      <Text style={[font.callout, styles.rowTitle, { color: enabled ? theme.label : theme.tertiaryLabel }]}>{title}</Text>
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
  const zoomButton = (icon: SymbolName, label: string, can: boolean, onPress: () => void) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={!can} onPress={onPress} style={styles.zoomButton}>
      <Symbol name={icon} size={16} color={can ? theme.label : theme.tertiaryLabel} />
    </Pressable>
  );
  return (
    <View testID="menuZoom" style={large ? styles.zoomStacked : styles.row}>
      <Text style={[font.callout, styles.rowTitle, large ? styles.zoomHeading : null, { color: model.isWebPage ? theme.label : theme.tertiaryLabel }]}>Page Zoom</Text>
      <View style={[styles.zoom, { backgroundColor: theme.tertiaryFill, borderRadius: capsule(pageMenuLayout.zoomHeight) }]}>
        {zoomButton("minus", "Zoom Out", model.zoomOut, zoomOut)}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset Zoom"
          accessibilityValue={{ text: model.zoomPercent }}
          disabled={!model.isWebPage}
          onPress={resetZoom}
          style={styles.zoomReset}
        >
          <Text style={[font.subheadline, styles.digits, styles.semibold, { color: theme.label }]}>{model.zoomPercent}</Text>
        </Pressable>
        {zoomButton("plus", "Zoom In", model.zoomIn, zoomIn)}
      </View>
    </View>
  );
}

const SEND_MENU_WIDTH = 250;
const TITLE_IN = FadeIn.duration(pageMenuMotion.titleFade);
const TITLE_OUT = FadeOut.duration(pageMenuMotion.titleFade);

const styles = StyleSheet.create({
  column: { padding: menuLayout.inset },
  largeBottom: { paddingBottom: menuLayout.inset + pageMenuLayout.accessibilityBottom },
  bar: { gap: pageMenuLayout.barSpacing },
  groups: { gap: pageMenuLayout.groupSpacing, paddingTop: pageMenuLayout.groupSpacing },
  capsule: { paddingHorizontal: space.xs },
  capsuleRow: { flexDirection: "row", alignItems: "center", minHeight: menuLayout.capsuleHeight },
  capsuleButton: { minWidth: 44, minHeight: menuLayout.capsuleHeight, alignItems: "center", justifyContent: "center" },
  capsuleDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: pageMenuLayout.rowInset },
  title: { flex: 1, paddingHorizontal: space.xs, justifyContent: "center", minHeight: menuLayout.capsuleHeight },
  titleBelow: { paddingHorizontal: space.s, paddingVertical: space.m },
  fill: { flex: 1 },
  centered: { textAlign: "center" },
  leading: { textAlign: "left" },
  feedback: { fontWeight: "600" },
  actions: { flexDirection: "row", gap: pageMenuLayout.barSpacing },
  action: { flex: 1, minHeight: menuLayout.capsuleHeight },
  actionHit: { flex: 1, minHeight: menuLayout.capsuleHeight, alignItems: "center", justifyContent: "center" },
  group: { borderRadius: menuLayout.innerRadius, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: pageMenuLayout.rowInset },
  row: { flexDirection: "row", alignItems: "center", minHeight: menuLayout.rowHeight, paddingHorizontal: pageMenuLayout.rowInset, gap: space.m },
  rowTitle: { flex: 1, paddingVertical: space.s },
  digits: { fontVariant: ["tabular-nums"] },
  semibold: { fontWeight: "600" },
  zoom: { flexDirection: "row", alignItems: "center", overflow: "hidden" },
  zoomStacked: { paddingHorizontal: pageMenuLayout.rowInset, paddingVertical: space.m, gap: space.s, alignItems: "flex-start", minHeight: menuLayout.rowHeight },
  zoomHeading: { alignSelf: "stretch", flex: 0 },
  zoomButton: { width: pageMenuLayout.zoomButtonWidth, height: pageMenuLayout.zoomHeight, alignItems: "center", justifyContent: "center" },
  zoomReset: { minWidth: pageMenuLayout.zoomReset, height: pageMenuLayout.zoomHeight, alignItems: "center", justifyContent: "center" },
});
