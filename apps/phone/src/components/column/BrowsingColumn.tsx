import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { haptics } from "../../state/app/haptics";
import type { ScreenColumn } from "../../state/app/screenLayout";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { capsule, chromeInk, ChromeSurface, Favicon, floatingBarLayout, PressScale, Symbol, tabsMotion, useReduceMotion, type ColorRoles } from "../ui";
import { barAddress, FloatingPlusButton, FloatingTabsButton, spokenAddress, type BarAddress } from "../browsing/FloatingBar";
import { NotSecureLock } from "../browsing/NotSecureLock";
import { columnLayout } from "./columnTokens";
import { SideColumn } from "./SideColumn";

type Props = {
  column: ScreenColumn;
  width: number;
  tab: BrowserTab;
  order: BrowserTab[];
  roles: ColorRoles;
  dark: boolean;
  hidden: boolean;
  onTabs: () => void;
  onTabsMenu: () => void;
  onStep: (delta: -1 | 1) => void;
  onAddress: () => void;
  onPlus: () => void;
  onMore: () => void;
};

export function BrowsingColumn({ column, width, tab, order, roles, dark, hidden, onTabs, onTabsMenu, onStep, onAddress, onPlus, onMore }: Props) {
  const reduceMotion = useReduceMotion();
  const hide = useSharedValue(hidden ? 1 : 0);
  useEffect(() => {
    hide.value = reduceMotion ? withTiming(hidden ? 1 : 0, { duration: tabsMotion.barCollapseReduced }) : withSpring(hidden ? 1 : 0, tabsMotion.barCollapse);
  }, [hidden, reduceMotion]);
  const fade = useAnimatedStyle(() => ({ opacity: 1 - hide.value }));
  return (
    <Animated.View
      testID="browsingColumn"
      collapsable={false}
      pointerEvents={hidden ? "none" : "box-none"}
      importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
      accessibilityElementsHidden={hidden}
      style={[StyleSheet.absoluteFill, fade]}
    >
      <SideColumn column={column} width={width} testID="browsingColumnStack">
        <FloatingTabsButton tab={tab} order={order} roles={roles} dark={dark} testID="columnTabs" onTabs={onTabs} onTabsMenu={onTabsMenu} onStep={onStep} />
        <ColumnSiteButton address={barAddress(tab)} isPrivate={tab.isPrivate} dark={dark} onPress={onAddress} />
        <PressScale label="Page Menu" onPress={onMore} onPressIn={haptics.barPress} style={styles.circle}>
          <ChromeSurface testID="columnMenu" shape="circle" cornerRadius={capsule(floatingBarLayout.control)} incognito={tab.isPrivate} dark={dark} barShadow style={styles.circle}>
            <Symbol name="ellipsis" size={floatingBarLayout.menuSymbol} color={(dark ? chromeInk.dark : chromeInk.light).foreground} />
          </ChromeSurface>
        </PressScale>
        <FloatingPlusButton tab={tab} dark={dark} testID="columnPlus" onPlus={onPlus} />
      </SideColumn>
    </Animated.View>
  );
}

function ColumnSiteButton({ address, isPrivate, dark, onPress }: { address: BarAddress; isPrivate: boolean; dark: boolean; onPress: () => void }) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  return (
    <PressScale label="Address" value={spokenAddress(address)} hint="Opens search with this page’s address." onPress={onPress} onPressIn={haptics.barPress} style={styles.circle}>
      <ChromeSurface testID="columnSite" shape="circle" cornerRadius={capsule(floatingBarLayout.control)} incognito={isPrivate} dark={dark} barShadow style={styles.circle}>
        <View testID="columnSiteMark" pointerEvents="none">
          {address.isPrivate ? (
            <Symbol name="eyeglassesThin" size={columnLayout.privateSymbol} color={ink.foreground} />
          ) : address.insecure ? (
            <NotSecureLock testID="columnSiteNotSecure" size={columnLayout.siteIcon} color={ink.notSecure} />
          ) : address.pageUrl ? (
            <Favicon iconUrl={address.iconUrl} pageUrl={address.pageUrl} size={columnLayout.siteIcon} />
          ) : (
            <Symbol name="magnifyingglass" size={columnLayout.searchSymbol} color={ink.foreground} />
          )}
        </View>
        {address.isPrivate && address.insecure ? (
          <View style={styles.lockBadge} pointerEvents="none">
            <NotSecureLock testID="columnSiteNotSecure" size={columnLayout.lockBadge} color={ink.notSecure} />
          </View>
        ) : null}
      </ChromeSurface>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  lockBadge: { position: "absolute", right: columnLayout.lockBadgeInset, bottom: columnLayout.lockBadgeInset },
  circle: { width: floatingBarLayout.control, height: floatingBarLayout.control, alignItems: "center", justifyContent: "center" },
});
