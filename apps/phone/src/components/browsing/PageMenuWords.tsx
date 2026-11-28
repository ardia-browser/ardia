import { Children, useState, type ReactNode, type RefObject } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ScrollViewInstance, type ScrollViewProps } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig } from "react-native-reanimated";
import { copy } from "../../lib/platformCopy";
import { actionWords, blockingWords } from "../../lib/sharedWords";
import {
  canPrintPages,
  canSummarizePages,
  summarizeCurrentPage,
  copyCurrentLink,
  editPageQuery,
  menuBack,
  menuForward,
  menuReload,
  menuStop,
  openInDefaultBrowser,
  openSiteSettings,
  openSiteSettingsSheet,
  pinCurrentToMac,
  printCurrentPage,
  sendCurrentTab,
  setBlockersOn,
  shareCurrentPage,
  shareOffersPrint,
  shareOverPageMenu,
  showFind,
  showReader,
} from "../../state/page/actions";
import { actionColumns } from "../../state/page/menuActionColumns";
import { menuSwitchHint, type MenuModel, type MenuSwitch } from "../../state/page/pageMenu";
import { useMenuTitle, useTitleFeedback } from "../../state/page/hooks";
import { useIsPinned, useSendTargets } from "../../state/sync/hooks";
import { useTab } from "../../state/tabs/hooks";
import { font, iconRoles, pageMenuLayout, pageMenuMotion, PressInPlace, SheetScrollView, smoothCorners, space, Symbol, ToggleRow as SharedToggleRow, usePressStyle, useTheme, type MenuItem, type SymbolName } from "../ui";
import { MenuTrigger } from "../ui/MenuTrigger";
import { syncOffered } from "../../state/sync/offer";
import { usePageSummariesEnabled } from "../../state/pageSummary/enabled";
import { pageMenuCards, pageMenuInkFrom } from "./pageMenuTokens";

export const usePageMenuInk = () => pageMenuInkFrom(useTheme());

const useAccessibilityText = () => useWindowDimensions().fontScale >= copy().menuLargeTextScale;

type Action = { icon: SymbolName; label: string; enabled: boolean; onPress: () => void };

function inRows<T>(items: T[], perRow: number): T[][] {
  const rows: T[][] = [];
  for (let at = 0; at < items.length; at += perRow) rows.push(items.slice(at, at + perRow));
  return rows;
}

function useActionColumns(labels: readonly string[]) {
  const { width, fontScale } = useWindowDimensions();
  const [measured, setMeasured] = useState<number | null>(null);
  const estimated = width - pageMenuCards.padding * 2;
  const available = measured ?? estimated;
  const columns = actionColumns(labels, available, pageMenuCards.tileGap, { fontSize: font.caption.fontSize, fontScale, advance: pageMenuCards.captionAdvance, maxLines: pageMenuCards.captionLines });
  return { columns, measure: (next: number) => (next > 0 ? setMeasured((now) => (Math.abs((now ?? estimated) - next) < 0.5 ? now : next)) : undefined) };
}

function MenuScroll({ scrollRef, showing, ...props }: ScrollViewProps & { scrollRef?: RefObject<ScrollViewInstance | null>; showing?: number }) {
  return scrollRef ? <ScrollView ref={scrollRef} bounces={false} overScrollMode="never" {...props} /> : <SheetScrollView bounces={false} overScrollMode="never" topFor={showing} {...props} />;
}

type PageMenuWordsProps = { tabId: string; model: MenuModel; onTranslate: () => void; systemSheet?: boolean; scrollRef?: RefObject<ScrollViewInstance | null>; onContentHeight?: (height: number) => void; showing?: number };

export function PageMenuWords({ tabId, model, onTranslate, systemSheet = false, scrollRef, onContentHeight, showing }: PageMenuWordsProps) {
  const large = useAccessibilityText();
  const devices = useSendTargets(tabId);
  const offersSummary = usePageSummariesEnabled() && canSummarizePages();
  const actions: Action[] = [
    { icon: "docPlaintext", label: "Reader", enabled: model.tiles, onPress: showReader },
    { icon: "textMagnifyingglass", label: "Find on Page", enabled: model.find, onPress: showFind },
    { icon: iconRoles.copyLink, label: actionWords.copyLink, enabled: model.tiles, onPress: copyCurrentLink },
    { icon: iconRoles.share, label: actionWords.share, enabled: model.tiles, onPress: systemSheet ? shareOverPageMenu : shareCurrentPage },
  ];
  const { columns, measure } = useActionColumns(actions.map((action) => action.label));
  const square = columns === actions.length;
  return (
    <MenuScroll scrollRef={scrollRef} showing={showing} testID="pageMenuWords" style={styles.scroll} contentContainerStyle={[styles.column, large ? styles.largeBottom : null]} bounces={false} onContentSizeChange={onContentHeight ? (width, height) => (width > pageMenuCards.padding * 2 + 1 ? onContentHeight(height) : undefined) : undefined}>
      <NavigationBar tabId={tabId} model={model} large={large} />
      <View testID="pageMenuActions" style={styles.actionRows} onLayout={(event) => measure(event.nativeEvent.layout.width)}>
        {inRows(actions, columns).map((row, index) => (
          <View key={index} testID="pageMenuActionRow" style={styles.actions}>
            {row.map((action) => (
              <ActionTile key={action.label} {...action} square={square} large={large} />
            ))}
          </View>
        ))}
      </View>
      <Group>
        {offersSummary ? <Row icon="sparkles" title="Summarize Page" enabled={model.summarize} onPress={summarizeCurrentPage} /> : null}
        {model.isWebPage && devices.length ? <SendRow devices={devices} /> : null}
        {model.pageRows ? (
          <ToggleRow which="blockers" icon={model.blockersEnabled ? "handRaised" : "handRaisedSlash"} title={blockingWords.blockAdsAndTrackers} value={model.blockersEnabled} enabled={model.siteSwitches} detail={model.blockedCount} onChange={setBlockersOn} />
        ) : null}
      </Group>
      <Group>
        {model.pageRows ? <Row icon="translate" title={model.translateTitle} enabled={model.translate} onPress={onTranslate} /> : null}
        {canPrintPages() && !shareOffersPrint() ? <Row icon="printer" title="Print" enabled={model.print} onPress={printCurrentPage} /> : null}
        <Row icon="gearshape" title="Site Settings" enabled onPress={systemSheet ? openSiteSettingsSheet : openSiteSettings} />
      </Group>
      {model.pageRows && model.offersDefaultBrowser ? (
        <Group>
          <Row icon="arrowUpForwardAppFill" title="Open in Default Browser" enabled onPress={openInDefaultBrowser} />
        </Group>
      ) : null}
    </MenuScroll>
  );
}

function NavigationBar({ tabId, model, large }: { tabId: string; model: MenuModel; large: boolean }) {
  const theme = useTheme();
  const ink = usePageMenuInk();
  const title = useMenuTitle(tabId);
  const feedback = useTitleFeedback();
  const shown = feedback ?? title;
  const titleStyle = usePressStyle("text", { style: large ? styles.titleBelow : styles.title });
  const titleButton = (
    <Pressable testID="pageMenuTitle" accessibilityRole="button" accessibilityLabel={shown} accessibilityHint="Edits the search" onPress={editPageQuery} style={titleStyle}>
      <LayoutAnimationConfig skipEntering>
        <Animated.Text
          key={shown}
          entering={TITLE_IN}
          exiting={TITLE_OUT}
          style={[font.body, styles.titleText, large && !feedback ? styles.leading : styles.centered, feedback ? styles.feedback : null, { color: feedback ? theme.spaceAccentInk : theme.label }]}
          numberOfLines={large ? 3 : feedback ? pageMenuCards.feedbackLines : 1}
        >
          {shown}
        </Animated.Text>
      </LayoutAnimationConfig>
    </Pressable>
  );
  return (
    <View testID="pageMenuCapsule" style={[styles.navigation, { backgroundColor: ink.cell }]}>
      <View testID="pageMenuCapsuleRow" style={styles.navigationRow}>
        <BarButton icon="chevronLeft" label="Back" enabled={model.back} onPress={menuBack} />
        <BarButton icon="chevronRight" label="Forward" enabled={model.forward} onPress={menuForward} />
        {large ? <View style={styles.fill} /> : titleButton}
        {syncOffered() ? <PinButton tabId={tabId} enabled={model.isWebPage} /> : null}
        {model.reload === "stop" ? <BarButton icon={iconRoles.stopLoading} label={actionWords.stopLoading} enabled onPress={menuStop} /> : <BarButton icon={iconRoles.reload} label={actionWords.reload} enabled={model.reloadEnabled} onPress={menuReload} />}
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
    <PressInPlace label={label} disabled={!enabled} onPress={onPress} style={styles.barButton}>
      <Symbol name={icon} size={pageMenuCards.barGlyph} color={enabled ? theme.label : theme.tertiaryLabel} />
    </PressInPlace>
  );
}

function ActionTile({ icon, label, enabled, square, large, onPress }: Action & { square: boolean; large: boolean }) {
  const theme = useTheme();
  const ink = usePageMenuInk();
  return (
    <View testID={`pageMenuAction:${label}`} style={styles.action}>
      <PressInPlace label={label} disabled={!enabled} onPress={onPress} grow style={styles.actionPress}>
        <View style={[styles.tile, square ? styles.tileSquare : styles.tileLarge, { backgroundColor: ink.cell }]}>
          <Symbol name={icon} size={pageMenuCards.tileGlyph} color={enabled ? theme.label : theme.tertiaryLabel} />
        </View>
        <Text
          testID={`pageMenuActionCaption:${label}`}
          importantForAccessibility="no"
          accessibilityElementsHidden
          style={[font.caption, styles.medium, styles.centered, { color: enabled ? theme.secondaryLabel : theme.tertiaryLabel }]}
          numberOfLines={large ? undefined : pageMenuCards.captionLines}
        >
          {label}
        </Text>
      </PressInPlace>
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
  const rowStyle = usePressStyle("row", { style: styles.row });
  return (
    <Pressable testID={`pageMenuRow:${title}`} accessibilityRole="button" accessibilityState={{ disabled: !enabled }} disabled={!enabled} onPress={onPress} style={rowStyle}>
      <RowIcon name={icon} enabled={enabled} />
      <Text style={[font.body, styles.rowTitle, { color: enabled ? theme.label : theme.tertiaryLabel }]}>{title}</Text>
    </Pressable>
  );
}

export function SendRow({ devices }: { devices: ReturnType<typeof useSendTargets> }) {
  const theme = useTheme();
  const rowStyle = usePressStyle("row", { style: styles.row });
  if (devices.length === 1) return <Row icon="paperplane" title={`Send to ${devices[0]!.name}`} enabled onPress={() => sendCurrentTab(devices[0]!)} />;
  const items: MenuItem[] = devices.map((device) => ({ label: device.name, icon: device.kind === "mac" ? "laptop" : "iphone", systemImage: device.kind === "mac" ? "laptopcomputer" : "iphone", onPress: () => sendCurrentTab(device) }));
  return (
    <MenuTrigger items={items} trigger="tap" place={{ left: space.xxl, width: pageMenuCards.sendMenuWidth }}>
      {({ onPress }) => (
        <Pressable testID="pageMenuRow:Send to Device" accessibilityRole="button" onPress={onPress} style={rowStyle}>
          <RowIcon name="paperplane" enabled />
          <Text style={[font.body, styles.rowTitle, { color: theme.label }]}>Send to Device</Text>
          <Symbol name="chevronUpChevronDown" size={pageMenuCards.sendChevron} color={theme.tertiaryLabel} />
        </Pressable>
      )}
    </MenuTrigger>
  );
}

type ToggleRowProps = { which: MenuSwitch; icon: SymbolName; title: string; value: boolean; enabled: boolean; detail?: string | null; onChange: (value: boolean) => void };

function ToggleRow({ which, icon, title, value, enabled, detail, onChange }: ToggleRowProps) {
  const theme = useTheme();
  return (
    <SharedToggleRow
      testID={`menuToggle:${title}`}
      press={copy().menuRowTogglesSwitch ? "row" : "knob"}
      label={detail ? `${title}, Blocked ${detail}` : title}
      hint={menuSwitchHint(which)}
      value={value}
      disabled={!enabled}
      onChange={onChange}
      style={styles.toggleRow}
    >
      <View style={styles.toggleWords}>
        <RowIcon name={icon} enabled={enabled} />
        <Text style={[font.body, styles.rowTitle, { color: enabled ? theme.label : theme.tertiaryLabel }]}>{title}</Text>
        {detail ? <Text style={[font.subheadline, styles.digits, { color: theme.secondaryLabel }]}>{detail}</Text> : null}
      </View>
    </SharedToggleRow>
  );
}

const TITLE_IN = FadeIn.duration(pageMenuMotion.titleFade);
const TITLE_OUT = FadeOut.duration(pageMenuMotion.titleFade);
const LABEL_START = pageMenuCards.rowInset + pageMenuCards.iconSlot + pageMenuCards.iconGap;

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, flexShrink: 1 },
  column: { padding: pageMenuCards.padding, gap: pageMenuCards.sectionGap },
  largeBottom: { paddingBottom: pageMenuCards.padding + pageMenuLayout.accessibilityBottom },
  navigation: { paddingHorizontal: space.xs, overflow: "hidden", borderRadius: pageMenuCards.navigationRadius, ...smoothCorners },
  navigationRow: { flexDirection: "row", alignItems: "center", minHeight: pageMenuCards.barHeight },
  barButton: { minWidth: pageMenuCards.barButton, minHeight: pageMenuCards.barHeight, alignItems: "center", justifyContent: "center" },
  navigationDivider: { height: pageMenuCards.divider, marginHorizontal: pageMenuCards.rowInset },
  title: { flex: 1, paddingHorizontal: space.xs, justifyContent: "center", minHeight: pageMenuCards.barHeight },
  titleBelow: { paddingHorizontal: space.s, paddingVertical: space.m },
  titleText: { fontWeight: "600" },
  fill: { flex: 1 },
  centered: { textAlign: "center" },
  leading: { textAlign: "left" },
  feedback: { fontWeight: "600" },
  actionRows: { gap: pageMenuCards.tileGap },
  actions: { flexDirection: "row", gap: pageMenuCards.tileGap },
  action: { flex: 1 },
  actionPress: { gap: pageMenuCards.tileLabelGap, alignItems: "stretch" },
  tile: { borderRadius: pageMenuCards.tileRadius, ...smoothCorners, alignItems: "center", justifyContent: "center" },
  tileSquare: { aspectRatio: 1 },
  tileLarge: { minHeight: pageMenuCards.largeTextTileHeight },
  medium: { fontWeight: "500" },
  group: { borderRadius: pageMenuCards.groupRadius, ...smoothCorners, overflow: "hidden" },
  divider: { height: pageMenuCards.divider, marginLeft: LABEL_START },
  row: { flexDirection: "row", alignItems: "center", minHeight: pageMenuCards.rowHeight, paddingHorizontal: pageMenuCards.rowInset, gap: pageMenuCards.iconGap },
  toggleRow: { minHeight: pageMenuCards.rowHeight, paddingHorizontal: pageMenuCards.rowInset, paddingVertical: space.none, gap: pageMenuCards.iconGap },
  toggleWords: { flexDirection: "row", alignItems: "center", gap: pageMenuCards.iconGap },
  icon: { width: pageMenuCards.iconSlot, alignItems: "center" },
  rowTitle: { flex: 1, paddingVertical: space.s },
  digits: { fontVariant: ["tabular-nums"] },
  semibold: { fontWeight: "600" },
});
