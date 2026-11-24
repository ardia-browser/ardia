import { useEffect, useRef, type ComponentProps } from "react";
import { StyleSheet, View, type ViewInstance } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useBarReturn } from "./barReturn";
import { AddressFace } from "./AddressFace";
import { NotSecureLock } from "./NotSecureLock";
import { haptics } from "../../state/app/haptics";
import { TabsMenuTrigger } from "./tabsMenu";
import { display } from "../../state/search/omnibox";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { BarPlusGlyph, capsule, chromeInk, chromeLayout, ChromeSurface, floatingBarLayout, PressInPlace, Symbol, type ColorRoles } from "../ui";
import { newTabLabel } from "./barWords";
import { openPageMenuFrom } from "./pageMenuOpener";
import { privateMark } from "../ui/IncognitoSpecs";
import { PressedGlyph } from "../ui/PressInPlace";
import { glassFadeMs } from "../ui/motion";
import { useFoldGlyphs, type BarFoldLook } from "./HostPill";
import { useGlassTrace } from "../../state/search/searchTiming";
import { TabStack } from "./BottomBar";
import { barReturnedToPage, deckPull } from "../../state/browse/deckPull";
import { FabricCatchUp } from "../ui/FabricCatchUp";
import { useDeckOwnsBar } from "../../state/browse/hooks";
import { usePageBusy } from "../../state/page/hooks";
import { PullGhost, PullGlyphs } from "./PagePull";
import { IncognitoGlyph, PlusGlyph, SearchTabsGlyph, SearchTabsGlyphs } from "../tabs/DeckBarGlyphs";
import { DUO_PLUS_ABOVE, type DuoSqueeze } from "../../lib/bottomBarSpan";
import { pageWords } from "../../lib/sharedWords";

type Props = {
  tab: BrowserTab;
  order: BrowserTab[];
  roles: ColorRoles;
  dark: boolean;
  showsPlus: boolean;
  anchors?: boolean;
  duo?: DuoBar | null;
  onTabs: () => void;
  onTabsMenu: () => void;
  onStep: (delta: -1 | 1) => void;
  onAddress: () => void;
  onPlus: () => void;
  onMore: () => void;
  fold?: BarFoldLook | null;
};

export type DuoBar = { stripLeft: number; stripTop: number; squeeze: DuoSqueeze | null; progress: SharedValue<number>; collapsed: boolean };

export type BarAddress = { tabId: string; host: string; insecure: boolean; isPrivate: boolean; iconUrl: string | null; pageUrl: string | null };

const AUTHORITY_PORT = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(?:\[[^\]]*\]|[^/?#:]*):0*(\d+)(?=[/?#]|$)/i;

export function withoutPort(host: string, url: string): string {
  const port = AUTHORITY_PORT.exec(url)?.[1];
  return port && host.endsWith(`:${port}`) ? host.slice(0, -port.length - 1) : host;
}

export function siteHost(url: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]/i.test(url)) return null;
  return withoutPort(display(url).host, url) || null;
}

export const spokenAddress = (address: BarAddress | null): string => (address ? [address.isPrivate ? "Incognito" : null, address.insecure ? "Not Secure" : null, address.host].filter(Boolean).join(", ") : "");

export function barAddress(tab: BrowserTab): BarAddress {
  const shown = display(tab.url);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(tab.url)?.[1]?.toLowerCase() ?? null;
  return {
    tabId: tab.id,
    host: withoutPort(shown.host, tab.url) || tab.title || pageWords.untitledTab,
    insecure: scheme === "http",
    isPrivate: tab.isPrivate,
    iconUrl: tab.faviconUrl,
    pageUrl: tab.url || null,
  };
}

export function FloatingBar({ tab, order, roles, dark, showsPlus, anchors = true, duo = null, fold = null, onTabs, onTabsMenu, onStep, onAddress, onPlus, onMore }: Props) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  const address = barAddress(tab);
  const menuButton = useRef<ViewInstance>(null);
  const returning = useBarReturn();
  const handed = useDeckOwnsBar();
  const wasHanded = useRef(handed);
  useEffect(() => {
    if (wasHanded.current && !handed) barReturnedToPage();
    wasHanded.current = handed;
  });
  const swaps = handed || wasHanded.current;
  const handedBack = swaps ? { ...returning, centreGlass: { shown: returning.centreGlass.shown && !handed, shownMs: 0 }, sidesGlass: { shown: returning.sidesGlass.shown && !handed, shownMs: 0 } } : returning;
  const back = useFoldedGlass(handedBack, fold?.glass ?? true);
  useGlassTrace("address", back.centreGlass);
  useGlassTrace("sides", back.sidesGlass);
  const centreFold = useFoldGlyphs(fold);
  const ids = anchors ? back.ids : null;
  const inStrip = duo !== null;
  const idle = useSharedValue(0);
  const progress = duo?.progress ?? idle;
  const squeeze = duo?.squeeze ?? null;
  const squeezed = squeeze !== null && (duo?.collapsed ?? false);
  const squeezedBusy = usePageBusy(squeezed ? address.tabId : null);
  const shut = (value: number) => {
    "worklet";
    return Math.min(Math.max(value, 0), 1);
  };
  const centreSqueeze = useAnimatedStyle(() => (squeeze ? { marginLeft: squeeze.marginLeft * shut(progress.value), marginRight: squeeze.marginRight * shut(progress.value) } : { marginLeft: 0, marginRight: 0 }), [squeeze]);
  const addressFade = useAnimatedStyle(() => (squeeze ? { opacity: 1 - shut(progress.value) } : { opacity: 1 }), [squeeze]);
  const dotsFade = useAnimatedStyle(() => (squeeze && address.insecure ? { opacity: 1 - shut(progress.value) } : { opacity: 1 }), [squeeze, address.insecure]);
  const lockFade = useAnimatedStyle(() => ({ opacity: shut(progress.value) }));
  const leading = (
    <Animated.View testID="floatingBarLeading" collapsable={false} style={back.leading} pointerEvents={back.sidesShown ? "box-none" : "none"} importantForAccessibility={back.sidesShown ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!back.sidesShown}>
      <FloatingTabsButton tab={tab} order={order} roles={roles} dark={dark} testID="floatingBarTabs" glass={back.sidesGlass} glyphs={back.leadingGlyphs} fold={fold} ghost={!handed} onTabs={onTabs} onTabsMenu={onTabsMenu} onStep={onStep} />
    </Animated.View>
  );
  const trailing = (
    <Animated.View testID="floatingBarTrailing" collapsable={false} style={[styles.circleHit, back.trailing]} pointerEvents={back.sidesShown ? "box-none" : "none"} importantForAccessibility={back.sidesShown ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!back.sidesShown}>
      {showsPlus ? <FloatingPlusButton tab={tab} dark={dark} testID="floatingBarPlus" glass={back.sidesGlass} glyphs={back.trailingGlyphs} fold={fold} ghost={!handed} onPlus={onPlus} /> : null}
    </Animated.View>
  );
  return (
    <>
    <View testID="floatingBar" style={styles.row} pointerEvents="box-none">
      {inStrip ? null : leading}
      <Animated.View testID="floatingBarCentre" nativeID={ids?.anchor} collapsable={false} style={[styles.addressSlot, centreSqueeze]} pointerEvents={back.centreShown ? "box-none" : "none"} importantForAccessibility={back.centreShown ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!back.centreShown}>
      <ChromeSurface testID="floatingBarAddress" shape="capsule" cornerRadius={capsule(floatingBarLayout.control)} incognito={tab.isPrivate} dark={dark} barShadow={chromeLayout.barCastsShadow} shown={back.centreGlass.shown} shownMs={back.centreGlass.shownMs} style={[styles.address, squeeze ? styles.squeezes : null]}>
        <Animated.View testID="floatingBarCentreGlyphs" nativeID={ids?.face} collapsable={false} style={[styles.addressRow, back.centreGlyphs]}>
        <Animated.View testID="floatingBarFoldGlyphs" collapsable={false} style={[styles.addressRow, centreFold]}>
        <PullGlyphs style={styles.addressRow}>
        <Animated.View testID="floatingBarAddressFade" collapsable={false} style={[styles.addressFade, addressFade]} pointerEvents={squeezed ? "none" : "box-none"} importantForAccessibility={squeezed ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={squeezed}>
        <AddressFace address={address} dark={dark} testIDPrefix="floatingBar" style={styles.addressHit} onPress={onAddress} onPressIn={haptics.barPress} />
        </Animated.View>
        <PressInPlace ref={menuButton} label={squeezed ? `Page Menu, ${spokenAddress(address)}` : "Page Menu"} busy={squeezed ? squeezedBusy : undefined} onPress={() => openPageMenuFrom(() => menuButton.current, onMore)} onPressIn={haptics.barPress} style={styles.menu}>
          <Animated.View style={[styles.menuGlyph, dotsFade]}>
            <Symbol name="ellipsis" size={floatingBarLayout.menuSymbol} color={ink.foreground} />
          </Animated.View>
          {squeeze && address.insecure ? (
            <Animated.View style={[styles.menuGlyph, styles.menuLock, lockFade]}>
              <NotSecureLock testID="floatingBarMoreNotSecure" size={floatingBarLayout.siteIcon} color={ink.notSecure} />
            </Animated.View>
          ) : null}
        </PressInPlace>
        </PullGlyphs>
        </Animated.View>
        </Animated.View>
        {handed ? null : (
          <PullGhost style={squeeze ? styles.ghostEnd : styles.ghostRow}>
            {squeeze ? (
              <View testID="floatingBarSearchGhost" style={styles.ghostSlot}>
                <SearchTabsGlyph dark={dark} />
              </View>
            ) : (
              <SearchTabsGlyphs dark={dark} />
            )}
          </PullGhost>
        )}
      </ChromeSurface>
      </Animated.View>
      {inStrip ? null : trailing}
    </View>
    {fold ? <BarMotionCatchUp fold={fold} /> : null}
    {inStrip ? (
      <Animated.View testID="floatingBarStrip" pointerEvents="box-none" style={[styles.strip, { left: duo.stripLeft, top: duo.stripTop }]}>
        {trailing}
        {leading}
      </Animated.View>
    ) : null}
    </>
  );
}

type ButtonProps = { tab: BrowserTab; dark: boolean; testID: string; glass?: { shown: boolean; shownMs: number }; glyphs?: ComponentProps<typeof Animated.View>["style"]; fold?: BarFoldLook | null; ghost?: boolean };

function BarMotionCatchUp({ fold }: { fold: BarFoldLook }) {
  const progress = fold.progress;
  const barMotionNow = () => {
    "worklet";
    return progress.value + deckPull.barBack.value + deckPull.shrink.value + deckPull.stage.value;
  };
  return <FabricCatchUp motion={barMotionNow} testID="floatingBarFabricCatchUp" />;
}

function useFoldedGlass<Back extends { centreGlass: { shown: boolean; shownMs: number }; sidesGlass: { shown: boolean; shownMs: number } }>(back: Back, unfolded: boolean): Back {
  const was = useRef(unfolded);
  const flips = was.current !== unfolded;
  useEffect(() => {
    was.current = unfolded;
  }, [unfolded]);
  if (unfolded && !flips) return back;
  const fade = (glass: { shown: boolean; shownMs: number }) => ({ shown: glass.shown && unfolded, shownMs: flips ? glassFadeMs : glass.shownMs });
  return { ...back, centreGlass: fade(back.centreGlass), sidesGlass: fade(back.sidesGlass) };
}

export function FloatingTabsButton({ tab, order, roles, dark, testID, glass, glyphs, fold = null, ghost = false, onTabs, onTabsMenu, onStep }: ButtonProps & { order: BrowserTab[]; roles: ColorRoles; onTabs: () => void; onTabsMenu: () => void; onStep: (delta: -1 | 1) => void }) {
  const count = order.length;
  const foldGlyphs = useFoldGlyphs(fold);
  return (
    <TabsMenuTrigger order={order} onTabsMenu={onTabsMenu}>
      {({ onLongPress, screenReaderActions }) => (
        <PressInPlace
          label="Tabs"
          value={`${count} ${count === 1 ? "tab" : "tabs"}`}
          hint="Touch and hold for recent tabs."
          longPressLabel="Recent Tabs"
          actions={[
            ...screenReaderActions,
            { name: "previousTab", label: "Previous Tab", run: () => onStep(-1) },
            { name: "nextTab", label: "Next Tab", run: () => onStep(1) },
          ]}
          onPress={onTabs}
          onPressIn={haptics.barPress}
          onLongPress={onLongPress}
          dims="glyph"
          style={styles.circleHit}
        >
          <ChromeSurface testID={testID} shape="circle" cornerRadius={capsule(floatingBarLayout.control)} incognito={tab.isPrivate} dark={dark} barShadow={chromeLayout.barCastsShadow} shown={glass?.shown} shownMs={glass?.shownMs} style={styles.circle}>
            <PullGlyphs>
              <Animated.View collapsable={false} style={foldGlyphs}>
                <PressedGlyph>
                  <Animated.View testID={`${testID}Glyphs`} pointerEvents="none" style={glyphs}>
                    <TabStack tabs={order.slice(-2)} roles={roles} />
                  </Animated.View>
                </PressedGlyph>
              </Animated.View>
            </PullGlyphs>
            {ghost ? (
              <PullGhost style={styles.ghost}>
                <IncognitoGlyph incognito={tab.isPrivate} dark={dark} />
              </PullGhost>
            ) : null}
          </ChromeSurface>
        </PressInPlace>
      )}
    </TabsMenuTrigger>
  );
}

export function FloatingPlusButton({ tab, dark, testID, glass, glyphs, fold = null, ghost = false, onPlus }: ButtonProps & { onPlus: () => void }) {
  const ink = dark ? chromeInk.dark : chromeInk.light;
  const foldGlyphs = useFoldGlyphs(fold);
  return (
    <PressInPlace label={newTabLabel(tab.isPrivate)} onPress={onPlus} onPressIn={haptics.barPress} dims="glyph" style={styles.circleHit}>
      <ChromeSurface testID={testID} shape="circle" cornerRadius={capsule(floatingBarLayout.control)} incognito={tab.isPrivate} dark={dark} barShadow={chromeLayout.barCastsShadow} shown={glass?.shown} shownMs={glass?.shownMs} style={styles.circle}>
        <PullGlyphs>
          <Animated.View collapsable={false} style={foldGlyphs}>
            <PressedGlyph>
              <Animated.View testID={`${testID}Glyphs`} pointerEvents="none" style={glyphs}>
                <BarPlusGlyph testID={`${testID}Glyph`} color={ink.foreground} />
              </Animated.View>
            </PressedGlyph>
          </Animated.View>
        </PullGlyphs>
        {ghost ? (
          <PullGhost style={styles.ghost}>
            <PlusGlyph dark={dark} />
          </PullGhost>
        ) : null}
      </ChromeSurface>
    </PressInPlace>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: floatingBarLayout.gap,
    paddingHorizontal: chromeLayout.barSideInset,
    height: floatingBarLayout.control,
  },
  circleHit: { width: floatingBarLayout.control, height: floatingBarLayout.control },
  strip: { position: "absolute", width: floatingBarLayout.control, gap: DUO_PLUS_ABOVE - floatingBarLayout.control },
  squeezes: { overflow: "hidden" },
  addressFade: { flex: 1, alignSelf: "stretch", flexDirection: "row" },
  menuGlyph: { alignItems: "center", justifyContent: "center" },
  menuLock: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0 },
  circle: { width: floatingBarLayout.control, height: floatingBarLayout.control, alignItems: "center", justifyContent: "center" },
  addressSlot: { flex: 1, height: floatingBarLayout.control },
  address: { flex: 1, height: floatingBarLayout.control, flexDirection: "row", alignItems: "center" },
  addressRow: { flex: 1, alignSelf: "stretch", flexDirection: "row", alignItems: "center" },
  addressHit: { flex: 1, height: floatingBarLayout.control, flexDirection: "row", alignItems: "center", gap: floatingBarLayout.addressSpacing, paddingLeft: floatingBarLayout.addressLead },
  menu: { width: floatingBarLayout.control, height: floatingBarLayout.control, alignItems: "center", justifyContent: "center" },
  ghost: { alignItems: "center", justifyContent: "center" },
  ghostRow: { flexDirection: "row", alignItems: "center" },
  ghostEnd: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end" },
  ghostSlot: { width: floatingBarLayout.control, height: floatingBarLayout.control, alignItems: "center", justifyContent: "center" },
});
