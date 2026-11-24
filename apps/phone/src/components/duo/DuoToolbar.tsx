import { useRef, type ReactNode, type Ref } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { actionWords } from "../../lib/sharedWords";
import { haptics } from "../../state/app/haptics";
import { newTab } from "../../state/browse/store";
import { useNavigation, usePageTone } from "../../state/browse/hooks";
import { editPageQuery, menuBack, menuForward, menuReload, menuStop, openPageMenu, shareCurrentPage } from "../../state/page/actions";
import { useIncognito, useSelectedTab } from "../../state/tabs/hooks";
import { isSyncableUrl, type BrowserTab } from "../../state/tabs/tabModels";
import { shownTone } from "../../lib/pageTone";
import { capsule, chromeInk, controlRadius, ChromeSurface, floatingBarLayout, iconRoles, isDarkColor, PressInPlace, rolesFor, smoothCorners, Symbol, Tappable, useTheme, type SymbolName } from "../ui";
import { AddressFace } from "../browsing/AddressFace";
import { barAddress } from "../browsing/FloatingBar";
import { openPageMenuFrom } from "../browsing/pageMenuOpener";
import { DUO } from "./duoLayout";

type Props = { showsAddress: boolean; sidebarShown: boolean; sidebar?: SharedValue<number>; onToggleSidebar: () => void };

export function useTabPrivate(tab: BrowserTab | null): boolean {
  const incognito = useIncognito();
  return tab ? tab.isPrivate : incognito;
}

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
  const incognito = useTabPrivate(tab);
  const menuButton = useRef<ViewInstance>(null);
  const capsuleStyle = useAnimatedStyle(() => ({ opacity: 1 - (sidebar?.value ?? (sidebarShown ? 1 : 0)) }), [sidebarShown]);
  return (
    <View testID="duoToolbar" style={styles.row} pointerEvents="box-none">
      <RoundButton icon="chevronLeft" label="Back" dark={dark} incognito={incognito} enabled={canGoBack} onPress={menuBack} />
      <RoundButton icon="chevronRight" label="Forward" dark={dark} incognito={incognito} enabled={canGoForward} onPress={menuForward} />
      {loading ? <RoundButton icon={iconRoles.stopLoading} label={actionWords.stopLoading} dark={dark} incognito={incognito} enabled onPress={menuStop} /> : <RoundButton icon={iconRoles.reload} label={actionWords.reload} dark={dark} incognito={incognito} enabled={tab !== null} onPress={menuReload} />}
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
      <RoundButton icon={iconRoles.share} label={actionWords.share} dark={dark} incognito={incognito} enabled={tab !== null && isSyncableUrl(tab.url)} onPress={shareCurrentPage} />
      <RoundButton buttonRef={menuButton} icon={iconRoles.more} label="Page Menu" dark={dark} incognito={incognito} enabled={tab !== null} onPress={() => openPageMenuFrom(() => menuButton.current, () => void openPageMenu())} />
    </View>
  );
}

function RoundButton({ icon, label, dark, incognito, enabled, onPress, buttonRef }: { icon: SymbolName; label: string; dark: boolean; incognito: boolean; enabled: boolean; onPress: () => void; buttonRef?: Ref<ViewInstance> }) {
  const roles = rolesFor(dark);
  return (
    <PressInPlace ref={buttonRef} label={label} disabled={!enabled} onPress={onPress} onPressIn={haptics.barPress} style={styles.round}>
      <ChromeSurface testID={`duoToolbar:${label}`} shape="rounded" cornerRadius={controlRadius(DUO.toolbarButton)} incognito={incognito} dark={dark} style={[styles.round, smoothCorners]}>
        <Symbol name={icon} size={DUO.toolbarGlyph} color={enabled ? roles.foregroundPrimary : roles.foregroundTertiary} />
      </ChromeSurface>
    </PressInPlace>
  );
}

function AddressCapsule({ tab, dark, sidebarShown, onToggleSidebar }: { tab: BrowserTab | null; dark: boolean; sidebarShown: boolean; onToggleSidebar: () => void }) {
  const roles = rolesFor(dark);
  const toggle = (
    <Tappable kind="icon" label={sidebarShown ? "Hide Sidebar" : "Show Sidebar"} onPress={onToggleSidebar} style={styles.sidebarButton}>
      <Symbol name={iconRoles.sidebar} size={DUO.sidebarGlyph} color={roles.foregroundPrimary} />
    </Tappable>
  );
  return <DuoAddressField layout="toolbar" tab={tab} dark={dark} leading={toggle} onPress={tab ? editPageQuery : newTab} />;
}

export type DuoAddressLayout = "toolbar" | "sidebar";

const ADDRESS_FACES = {
  toolbar: { testID: "duoAddress", shape: "capsule", corner: capsule(DUO.addressHeight) },
  sidebar: { testID: "duoSidebarAddress", shape: "rounded", corner: controlRadius(DUO.sidebarFieldHeight) },
} as const;

export function DuoAddressField({ layout, tab, dark, leading, onPress }: { layout: DuoAddressLayout; tab: BrowserTab | null; dark: boolean; leading?: ReactNode; onPress: () => void }) {
  const face = ADDRESS_FACES[layout];
  const incognito = useTabPrivate(tab);
  const hit = layout === "toolbar" ? styles.hostButton : styles.sidebarFieldHit;
  return (
    <ChromeSurface testID={face.testID} shape={face.shape} cornerRadius={face.corner} incognito={incognito} dark={dark} style={[layout === "toolbar" ? styles.address : styles.sidebarField, smoothCorners]}>
      {leading}
      {tab ? <AddressFace address={barAddress(tab)} dark={dark} testIDPrefix="duo" style={hit} onPress={onPress} /> : <NewTabFace dark={dark} style={hit} onPress={onPress} />}
    </ChromeSurface>
  );
}

function NewTabFace({ dark, style, onPress }: { dark: boolean; style: StyleProp<ViewStyle>; onPress: () => void }) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  return (
    <Tappable testID="duoNewTab" kind="text" label={actionWords.newTab} onPress={onPress} style={style}>
      <Symbol name={iconRoles.newTab} size={floatingBarLayout.siteIcon} color={ink.secondary} />
      <Text testID="duoHost" maxFontSizeMultiplier={floatingBarLayout.maxTextScale} numberOfLines={1} style={[styles.newTabLabel, { color: ink.secondary }]}>
        {actionWords.newTab}
      </Text>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: DUO.toolbarGap, paddingHorizontal: DUO.toolbarInset, height: DUO.toolbarButton },
  spacer: { flex: 1, minWidth: DUO.toolbarGap },
  round: { width: DUO.toolbarButton, height: DUO.toolbarButton, alignItems: "center", justifyContent: "center" },
  addressSlot: { flexShrink: 1, minWidth: 0 },
  address: { height: DUO.addressHeight, flexDirection: "row", alignItems: "center", gap: DUO.addressGap, paddingLeft: DUO.addressLead - DUO.addressSidebarInset, paddingRight: DUO.addressTrail },
  sidebarButton: { width: DUO.addressSidebarButton, height: DUO.addressHeight, alignItems: "center", justifyContent: "center" },
  hostButton: { flexShrink: 1, height: DUO.addressHeight, flexDirection: "row", alignItems: "center", gap: floatingBarLayout.addressSpacing },
  sidebarField: { height: DUO.sidebarFieldHeight },
  newTabLabel: { flexShrink: 1, fontSize: floatingBarLayout.hostText },
  sidebarFieldHit: { flex: 1, paddingHorizontal: DUO.sidebarFieldPadding, flexDirection: "row", alignItems: "center", gap: floatingBarLayout.addressSpacing },
});
