import { Children, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Pressable } from "react-native-gesture-handler";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { withAlpha } from "../../lib/color";
import { copy } from "../../lib/platformCopy";
import { actionWords, blockingWords } from "../../lib/sharedWords";
import {
  canPrintPages,
  canSummarizePages,
  closeMenuSubpage,
  copyCurrentLink,
  editPageQuery,
  menuBack,
  menuForward,
  menuReload,
  menuStop,
  openInDefaultBrowser,
  openSiteSettings,
  openSiteSettingsRoute,
  pinCurrentToMac,
  printCurrentPage,
  sendCurrentTab,
  setBlockersOn,
  shareCurrentPage,
  showFind,
  showReader,
  summarizeCurrentPage,
} from "../../state/page/actions";
import { menuSwitchHint, type MenuModel, type MenuSwitch } from "../../state/page/pageMenu";
import { useMenuTitle, useTitleFeedback } from "../../state/page/hooks";
import type { MenuPage } from "../../state/page/store";
import { useIsPinned, useSendTargets } from "../../state/sync/hooks";
import { syncOffered } from "../../state/sync/offer";
import { useTab } from "../../state/tabs/hooks";
import { usePageSummariesEnabled } from "../../state/pageSummary/enabled";
import { MaterialSettingsSheetSurface } from "../settings/MaterialSettingsKit";
import { AllowedSites, SiteSettingsGroups } from "../settings/SitePages";
import { ThisSiteGroup } from "../settings/ThisSite";
import { Favicon, iconRoles, MaterialIconButton, Symbol, Toggle, type MenuItem, type SymbolName } from "../ui";
import { MATERIAL_STATE } from "../ui/materialRoles";
import { useMaterialRipple } from "../ui/MaterialSurfaces";
import { useMaterialTheme } from "../ui/materialTheme";
import { MATERIAL_SEGMENT_GAP, materialDuration, materialSegmentCorners, materialShape, materialSize, materialType } from "../ui/materialTokens";
import { MenuTrigger } from "../ui/MenuTrigger";
import { barAddress } from "./FloatingBar";

const TONAL_BUTTON_HEIGHT = 40;
const SEND_MENU_WIDTH = 250;
const TITLE_IN = FadeIn.duration(materialDuration.short4);
const TITLE_OUT = FadeOut.duration(materialDuration.short2);


export function MaterialPageMenu({ tabId, model, page = "main", onTranslate }: { tabId: string; model: MenuModel; page?: MenuPage; onTranslate: () => void }) {
  if (page === "siteSettings") {
    return (
      <>
        <MaterialSiteSettingsHeader onBack={closeMenuSubpage} />
        <ScrollView testID="materialPageMenuSiteSettings" contentContainerStyle={styles.column} bounces={false}>
          <MaterialSiteSettingsContent />
        </ScrollView>
      </>
    );
  }
  return (
    <ScrollView testID="materialPageMenu" contentContainerStyle={styles.column} bounces={false}>
      <MenuHeader tabId={tabId} model={model} />
      <MaterialPageMenuItems tabId={tabId} model={model} onTranslate={onTranslate} />
    </ScrollView>
  );
}

export function MaterialSiteSettingsHeader({ onBack }: { onBack: () => void }) {
  const { scheme } = useMaterialTheme();
  return (
    <View testID="materialSiteSettingsHeader" style={styles.subpageHeader}>
      <MaterialIconButton testID="siteSettingsSheetBack" icon="arrowRight" flipped label="Back" ink={scheme.onSurface} onPress={onBack} />
      <Text accessibilityRole="header" numberOfLines={1} style={[materialType.titleLarge, styles.flex, { color: scheme.onSurface }]}>
        Site Settings
      </Text>
    </View>
  );
}

export function MaterialSiteSettingsContent() {
  return (
    <MaterialSettingsSheetSurface>
      <ThisSiteGroup />
      <SiteSettingsGroups openRoute={openSiteSettingsRoute} />
      <AllowedSites />
    </MaterialSettingsSheetSurface>
  );
}

export function MaterialPageMenuItems({ tabId, model, onTranslate, onFind = showFind }: { tabId: string; model: MenuModel; onTranslate: () => void; onFind?: () => void }) {
  const large = useWindowDimensions().fontScale >= copy().menuLargeTextScale;
  const devices = useSendTargets(tabId);
  const offersSummary = usePageSummariesEnabled() && canSummarizePages();
  return (
    <>
      {large ? (
        <Group>
          <ListRow icon="docPlaintext" title="Reader" enabled={model.tiles} onPress={showReader} />
          <ListRow icon={iconRoles.copyLink} title={actionWords.copyLink} enabled={model.tiles} onPress={copyCurrentLink} />
          <ListRow icon={iconRoles.share} title={actionWords.share} enabled={model.tiles} onPress={shareCurrentPage} />
        </Group>
      ) : (
        <View testID="materialPageMenuActions" style={styles.actions}>
          <TonalButton icon="docPlaintext" title="Reader" enabled={model.tiles} onPress={showReader} />
          <TonalButton icon={iconRoles.copyLink} title={actionWords.copyLink} enabled={model.tiles} onPress={copyCurrentLink} />
          <TonalButton icon={iconRoles.share} title={actionWords.share} enabled={model.tiles} onPress={shareCurrentPage} />
        </View>
      )}
      <Groups>
        <Group>
          <ListRow icon="textMagnifyingglass" title="Find on Page" enabled={model.find} onPress={onFind} />
          {offersSummary ? <ListRow icon="sparkles" title="Summarize Page" enabled={model.summarize} onPress={summarizeCurrentPage} /> : null}
          {model.isWebPage && devices.length ? <SendRow devices={devices} /> : null}
          {canPrintPages() ? <ListRow icon="printer" title="Print" enabled={model.print} onPress={printCurrentPage} /> : null}
        </Group>
        <Group>
          {model.pageRows ? <ListRow icon="translate" title={model.translateTitle} enabled={model.translate} onPress={onTranslate} /> : null}
          {model.pageRows ? (
            <SwitchRow
              which="blockers"
              icon={model.blockersEnabled ? "handRaised" : "handRaisedSlash"}
              title={blockingWords.blockAdsAndTrackers}
              value={model.blockersEnabled}
              enabled={model.siteSwitches}
              supporting={model.blockedCount ? `${model.blockedCount} blocked` : null}
              onChange={setBlockersOn}
            />
          ) : null}
          <ListRow icon="gearshape" title="Site Settings" enabled onPress={openSiteSettings} />
        </Group>
        {model.pageRows && model.offersDefaultBrowser ? (
          <Group>
            <ListRow icon="safariFill" title="Open in Default Browser" enabled onPress={openInDefaultBrowser} />
          </Group>
        ) : null}
      </Groups>
    </>
  );
}

function MenuHeader({ tabId, model }: { tabId: string; model: MenuModel }) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  const tab = useTab(tabId);
  const title = useMenuTitle(tabId);
  const feedback = useTitleFeedback();
  const shown = feedback ?? title;
  const address = tab ? barAddress(tab) : null;
  return (
    <View testID="materialPageMenuHeader">
      <Pressable testID="pageMenuTitle" accessibilityRole="button" accessibilityLabel={shown} accessibilityHint="Edits the search" android_ripple={ripple} onPress={editPageQuery} style={styles.titleRow}>
        {address?.pageUrl && !address.isPrivate ? (
          <Favicon iconUrl={address.iconUrl} pageUrl={address.pageUrl} size={materialSize.icon} />
        ) : (
          <Symbol name={address?.isPrivate ? "eyes" : "magnifyingglass"} size={materialSize.icon} color={scheme.onSurfaceVariant} />
        )}
        <Animated.Text key={shown} entering={TITLE_IN} exiting={TITLE_OUT} numberOfLines={1} style={[materialType.titleMedium, styles.flex, { color: feedback ? scheme.primary : scheme.onSurface }]}>
          {shown}
        </Animated.Text>
      </Pressable>
      <View testID="materialPageMenuNav" style={styles.nav}>
        <IconButton icon="chevronLeft" label="Back" enabled={model.back} onPress={menuBack} />
        <IconButton icon="chevronRight" label="Forward" enabled={model.forward} onPress={menuForward} />
        {model.reload === "stop" ? <IconButton icon={iconRoles.stopLoading} label={actionWords.stopLoading} enabled onPress={menuStop} /> : <IconButton icon={iconRoles.reload} label={actionWords.reload} enabled={model.reloadEnabled} onPress={menuReload} />}
        {syncOffered() ? <PinButton tabId={tabId} enabled={model.isWebPage} /> : null}
      </View>
    </View>
  );
}

function PinButton({ tabId, enabled }: { tabId: string; enabled: boolean }) {
  const tab = useTab(tabId);
  const pinned = useIsPinned(tabId);
  return <IconButton icon={pinned ? "starFill" : "star"} label={pinned ? "Pinned to Mac" : "Pin to Mac"} enabled={enabled && !tab?.isPrivate} selected={pinned} onPress={pinCurrentToMac} />;
}

function IconButton({ icon, label, enabled, selected, onPress }: { icon: SymbolName; label: string; enabled: boolean; selected?: boolean; onPress: () => void }) {
  return <MaterialIconButton testID={`materialMenuIcon:${label}`} icon={icon} label={label} enabled={enabled} selected={selected} onPress={onPress} />;
}

function TonalButton({ icon, title, enabled, onPress }: { icon: SymbolName; title: string; enabled: boolean; onPress: () => void }) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  const ink = enabled ? scheme.onSecondaryContainer : withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContent);
  const fill = enabled ? scheme.secondaryContainer : withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContainer);
  return (
    <Pressable
      testID={`materialMenuAction:${title}`}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      android_ripple={ripple}
      hitSlop={(materialSize.touchTarget - TONAL_BUTTON_HEIGHT) / 2}
      onPress={onPress}
      style={[styles.tonal, { backgroundColor: fill }]}
    >
      <Symbol name={icon} size={18} color={ink} />
      <Text numberOfLines={1} ellipsizeMode="tail" style={[materialType.labelLarge, styles.tonalLabel, { color: ink }]}>
        {title}
      </Text>
    </Pressable>
  );
}

function Groups({ children }: { children: ReactNode }) {
  return <View style={styles.groups}>{children}</View>;
}

function Group({ children }: { children: ReactNode }) {
  const { scheme } = useMaterialTheme();
  const rows = Children.toArray(children);
  if (!rows.length) return null;
  return (
    <View testID="materialMenuGroup" style={styles.group}>
      {rows.map((row, index) => (
        <View key={index} testID="materialMenuSegment" style={[styles.segment, materialSegmentCorners(index, rows.length), { backgroundColor: scheme.surfaceContainerHighest }]}>
          {row}
        </View>
      ))}
    </View>
  );
}

function RowContent({ icon, title, enabled, supporting, trailing }: { icon: SymbolName; title: string; enabled: boolean; supporting?: string | null; trailing?: ReactNode }) {
  const { scheme } = useMaterialTheme();
  const off = withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContent);
  return (
    <>
      <Symbol name={icon} size={materialSize.icon} color={enabled ? scheme.onSurfaceVariant : off} />
      <View style={styles.flex}>
        <Text style={[materialType.bodyLarge, { color: enabled ? scheme.onSurface : off }]}>
          {title}
        </Text>
        {supporting ? (
          <Text style={[materialType.bodyMedium, styles.digits, { color: enabled ? scheme.onSurfaceVariant : off }]}>
            {supporting}
          </Text>
        ) : null}
      </View>
      {trailing}
    </>
  );
}

function ListRow({ icon, title, enabled, onPress }: { icon: SymbolName; title: string; enabled: boolean; onPress: () => void }) {
  const ripple = useMaterialRipple();
  return (
    <Pressable testID={`pageMenuRow:${title}`} accessibilityRole="button" accessibilityState={{ disabled: !enabled }} disabled={!enabled} android_ripple={ripple} onPress={onPress} style={styles.row}>
      <RowContent icon={icon} title={title} enabled={enabled} />
    </Pressable>
  );
}

function SendRow({ devices }: { devices: ReturnType<typeof useSendTargets> }) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  if (devices.length === 1) return <ListRow icon="paperplane" title={`Send to ${devices[0]!.name}`} enabled onPress={() => sendCurrentTab(devices[0]!)} />;
  const items: MenuItem[] = devices.map((device) => ({ label: device.name, icon: device.kind === "mac" ? "laptop" : "iphone", systemImage: device.kind === "mac" ? "laptopcomputer" : "iphone", onPress: () => sendCurrentTab(device) }));
  return (
    <MenuTrigger items={items} trigger="tap" frost={null} place={{ left: materialSize.touchTarget, width: SEND_MENU_WIDTH }}>
      {({ onPress }) => (
        <Pressable testID="pageMenuRow:Send to Device" accessibilityRole="button" android_ripple={ripple} onPress={onPress ? () => onPress() : undefined} style={styles.row}>
          <RowContent icon="paperplane" title="Send to Device" enabled trailing={<Symbol name="chevronDown" size={materialSize.icon} color={scheme.onSurfaceVariant} />} />
        </Pressable>
      )}
    </MenuTrigger>
  );
}

function SwitchRow({ which, icon, title, value, enabled, supporting, onChange }: { which: MenuSwitch; icon: SymbolName; title: string; value: boolean; enabled: boolean; supporting?: string | null; onChange: (value: boolean) => void }) {
  const ripple = useMaterialRipple();
  const label = supporting ? `${title}, ${supporting}` : title;
  return (
    <Pressable
      testID={`menuToggle:${title}`}
      accessible
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={menuSwitchHint(which)}
      accessibilityState={{ checked: value, disabled: !enabled }}
      disabled={!enabled}
      android_ripple={ripple}
      onPress={() => onChange(!value)}
      style={[styles.row, supporting ? styles.rowTwoLine : null]}
    >
      <RowContent
        icon={icon}
        title={title}
        enabled={enabled}
        supporting={supporting}
        trailing={
          <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden pointerEvents="none">
            <Toggle label={title} value={value} disabled={!enabled} onChange={onChange} />
          </View>
        }
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  column: { paddingBottom: 16 },
  subpageHeader: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: materialSize.touchTarget, paddingLeft: 4, paddingRight: 16 },
  groups: { gap: 12, paddingHorizontal: 16, paddingTop: 8 },
  group: { gap: MATERIAL_SEGMENT_GAP },
  segment: { overflow: "hidden" },
  flex: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 16, minHeight: materialSize.listItemOneLine, paddingHorizontal: 24 },
  nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingHorizontal: 12, minHeight: materialSize.touchTarget + 8 },
  actions: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  tonal: { flexGrow: 1, flexShrink: 1, height: TONAL_BUTTON_HEIGHT, borderRadius: materialShape.full, overflow: "hidden", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 10 },
  tonalLabel: { flexShrink: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 16, minHeight: materialSize.listItemOneLine, paddingLeft: 16, paddingRight: 16, paddingVertical: 8 },
  rowTwoLine: { minHeight: materialSize.listItemTwoLine },
  digits: { fontVariant: ["tabular-nums"] },
});
