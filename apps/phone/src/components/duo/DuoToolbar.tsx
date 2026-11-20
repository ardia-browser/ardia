import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { haptics } from "../../state/app/haptics";
import { newTab } from "../../state/browse/store";
import { useNavigation, usePageTone } from "../../state/browse/hooks";
import { editPageQuery, menuBack, menuForward, menuReload, menuStop, openPageMenu, shareCurrentPage } from "../../state/page/actions";
import { useIncognito, useSelectedTab } from "../../state/tabs/hooks";
import { isSyncableUrl, type BrowserTab } from "../../state/tabs/tabModels";
import { shownTone } from "../../lib/pageTone";
import { capsule, chromeInk, ChromeSurface, IncognitoSpecs, isDarkColor, PressScale, rolesFor, Symbol, useTheme, type SymbolName } from "../ui";
import { barAddress, spokenAddress, type BarAddress } from "../browsing/FloatingBar";
import { NotSecureLock } from "../browsing/NotSecureLock";
import { DUO } from "./duoLayout";
import { SIDEBAR_GLYPH } from "./tokens";

type Props = { showsAddress: boolean; sidebarShown: boolean; sidebar?: SharedValue<number>; onToggleSidebar: () => void };

export function useToolbarDark(tab: BrowserTab | null): boolean {
  const theme = useTheme();
  const incognito = useIncognito();
  const tone = usePageTone(tab?.id ?? null);
  const failed = useNavigation(tab?.id ?? null, (n) => n?.failure != null);
  const top = tab && !failed ? shownTone(tone, tab.themeColorHex).top : null;
  return top ? isDarkColor(top) : incognito || theme.dark;
}

export function DuoToolbar({ showsAddress, sidebarShown, sidebar, onToggleSidebar }: Props) {
  const tab = useSelectedTab();
  const id = tab?.id ?? null;
  const canGoBack = useNavigation(id, (n) => n?.canGoBack ?? false);
  const canGoForward = useNavigation(id, (n) => n?.canGoForward ?? false);
  const loading = useNavigation(id, (n) => n?.isLoading ?? false);
  const dark = useToolbarDark(tab);
  const capsuleStyle = useAnimatedStyle(() => ({ opacity: 1 - (sidebar?.value ?? (sidebarShown ? 1 : 0)) }), [sidebarShown]);
  return (
    <View testID="duoToolbar" style={styles.row} pointerEvents="box-none">
      <RoundButton icon="chevronLeft" label="Back" dark={dark} enabled={canGoBack} onPress={menuBack} />
      <RoundButton icon="chevronRight" label="Forward" dark={dark} enabled={canGoForward} onPress={menuForward} />
      {loading ? <RoundButton icon="xmark" label="Stop Loading" dark={dark} enabled onPress={menuStop} /> : <RoundButton icon="arrowClockwise" label="Reload" dark={dark} enabled={tab !== null} onPress={menuReload} />}
      <View style={styles.spacer} />
      {showsAddress ? (
        <>
          <Animated.View
            testID="duoAddressSlot"
            style={[styles.addressSlot, capsuleStyle]}
            collapsable={false}
            pointerEvents={sidebarShown ? "none" : "box-none"}
            importantForAccessibility={sidebarShown ? "no-hide-descendants" : "auto"}
            accessibilityElementsHidden={sidebarShown}
          >
            <AddressCapsule tab={tab} dark={dark} sidebarShown={sidebarShown} onToggleSidebar={onToggleSidebar} />
          </Animated.View>
          <View style={styles.spacer} />
        </>
      ) : null}
      <RoundButton icon="squareAndArrowUp" label="Share" dark={dark} enabled={tab !== null && isSyncableUrl(tab.url)} onPress={shareCurrentPage} />
      <RoundButton icon="ellipsis" label="Page Menu" dark={dark} enabled={tab !== null} onPress={() => void openPageMenu()} />
    </View>
  );
}

function RoundButton({ icon, label, dark, enabled, onPress }: { icon: SymbolName; label: string; dark: boolean; enabled: boolean; onPress: () => void }) {
  const roles = rolesFor(dark);
  return (
    <PressScale label={label} disabled={!enabled} onPress={onPress} onPressIn={haptics.barPress} style={styles.round}>
      <ChromeSurface testID={`duoToolbar:${label}`} shape="circle" cornerRadius={capsule(DUO.toolbarButton)} dark={dark} style={styles.round}>
        <Symbol name={icon} size={DUO.toolbarGlyph} color={enabled ? roles.foregroundPrimary : roles.foregroundTertiary} />
      </ChromeSurface>
    </PressScale>
  );
}

function AddressCapsule({ tab, dark, sidebarShown, onToggleSidebar }: { tab: BrowserTab | null; dark: boolean; sidebarShown: boolean; onToggleSidebar: () => void }) {
  const roles = rolesFor(dark);
  const address = tab ? barAddress(tab) : null;
  return (
    <ChromeSurface testID="duoAddress" shape="capsule" cornerRadius={capsule(DUO.addressHeight)} dark={dark} style={styles.address}>
      <Pressable accessibilityRole="button" accessibilityLabel={sidebarShown ? "Hide Sidebar" : "Show Sidebar"} onPress={onToggleSidebar} style={styles.sidebarButton}>
        <SidebarGlyph size={DUO.sidebarGlyph} color={roles.foregroundPrimary} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Address"
        accessibilityValue={{ text: spokenAddress(address) }}
        accessibilityHint="Opens search with this page’s address."
        onPress={tab ? editPageQuery : newTab}
        style={styles.hostButton}
      >
        <HostLabel address={address} dark={dark} />
      </Pressable>
    </ChromeSurface>
  );
}

export function HostLabel({ address, dark }: { address: BarAddress | null; dark: boolean }) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  const roles = rolesFor(dark);
  return (
    <View testID="duoHost" style={styles.host} pointerEvents="none">
      {address?.isPrivate ? <IncognitoSpecs size={DUO.hostLock} color={roles.foregroundSecondary} /> : null}
      {address?.insecure ? (
        <NotSecureLock testID="duoHostNotSecure" size={DUO.hostLock} color={ink.notSecure} />
      ) : address?.isPrivate ? null : address?.pageUrl ? (
        <Symbol name="lockFill" size={DUO.hostLock} color={roles.foregroundSecondary} />
      ) : null}
      <Text testID="duoHostText" maxFontSizeMultiplier={DUO.hostMaxTextScale} numberOfLines={1} ellipsizeMode="middle" style={[styles.hostText, styles.hostName, { color: roles.foregroundPrimary }]}>
        {address?.host ?? ""}
      </Text>
    </View>
  );
}

export function SidebarGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={SIDEBAR_GLYPH.frame} fill="none" stroke={color} strokeWidth={SIDEBAR_GLYPH.stroke} strokeLinejoin="round" />
      <Path d={SIDEBAR_GLYPH.divider} fill="none" stroke={color} strokeWidth={SIDEBAR_GLYPH.stroke} strokeLinecap="round" />
      <Path d={SIDEBAR_GLYPH.rows} fill="none" stroke={color} strokeWidth={SIDEBAR_GLYPH.stroke} strokeLinecap="round" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: DUO.toolbarGap, paddingHorizontal: DUO.toolbarInset, height: DUO.toolbarButton },
  spacer: { flex: 1, minWidth: DUO.toolbarGap },
  round: { width: DUO.toolbarButton, height: DUO.toolbarButton, alignItems: "center", justifyContent: "center" },
  addressSlot: { flexShrink: 1, minWidth: 0 },
  address: { height: DUO.addressHeight, flexDirection: "row", alignItems: "center", gap: DUO.addressGap, paddingLeft: DUO.addressLead - DUO.addressSidebarInset, paddingRight: DUO.addressTrail },
  sidebarButton: { width: DUO.addressSidebarButton, height: DUO.addressHeight, alignItems: "center", justifyContent: "center" },
  hostButton: { flexShrink: 1, height: DUO.addressHeight, justifyContent: "center" },
  host: { flexDirection: "row", alignItems: "center", gap: DUO.hostGap },
  hostText: { fontSize: DUO.hostText },
  hostName: { flexShrink: 1 },
});
