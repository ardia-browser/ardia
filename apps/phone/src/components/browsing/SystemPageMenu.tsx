import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { BottomSheet, Button, ConfirmationDialog, Group, Host, RNHostView, Text, VStack } from "@expo/ui/swift-ui";
import { ignoreSafeArea, presentationDetents, presentationDragIndicator, type PresentationDetent } from "@expo/ui/swift-ui/modifiers";
import { askTranslation, closeMenuSubpage, confirmTranslation, isCurrentShowing, pageMenuHostGone, pageMenuPresentation, releaseTranslationAsk, type MenuPresentation } from "../../state/page/actions";
import { usePageUi } from "../../state/page/store";
import { useMenuModel, useMenuOpen, useMenuOpening, useMenuPage, usePageQuiet, useTranslationAsk } from "../../state/page/hooks";
import { markMenuPhase } from "../../state/page/menuTiming";
import { concentricRadius, menuLayout, moveTo, smoothCorners, spring, settingsUIAvailable, tabsLayout, useTheme } from "../ui";
import { screenCornerRadius } from "../../state/app/displayCorner";
import { menuInk } from "../ui/tokens";
import { pageMenuCards } from "./pageMenuTokens";
import type { Design } from "../../lib/design";
import { MenuSiteHeader, MenuSiteWords, PageMenuWords, usePageMenuInk } from "./PageMenuWords";

const contentLaidOut = () => markMenuPhase("laidOut");
const presentationIgnored = () => undefined;
const UNMEASURED_DETENTS: PresentationDetent[] = ["medium", "large"];

let lastMenuHeight: number | null = null;

export const menuDetents = (height: number | null): PresentationDetent[] => (height ? [{ height }] : UNMEASURED_DETENTS);

export const usesSystemPageMenu = (design: Design) => design === "redesigned" && Platform.OS === "ios" && settingsUIAvailable();

export function SystemPageMenuHost({ tabId }: { tabId: string }) {
  const open = useMenuOpen();
  const [armed, setArmed] = useState(open);
  const quiet = usePageQuiet(tabId, armed);
  if (!armed && (open || quiet)) setArmed(true);
  const shownToken = useRef<number | null>(null);
  useEffect(() => () => pageMenuHostGone(shownToken.current), []);
  if (!armed && !open) return null;
  return <SystemPageMenu tabId={tabId} open={open} shownToken={shownToken} onPresentation={pageMenuPresentation} />;
}

type SystemPageMenuProps = { tabId: string; open: boolean; shownToken?: RefObject<number | null>; onPresentation: (presentation: MenuPresentation) => void };

export function SystemPageMenu({ tabId, open, shownToken, onPresentation }: SystemPageMenuProps) {
  const scroll = useRef<ScrollViewInstance | null>(null);
  const token = useMenuOpening();
  useLayoutEffect(() => {
    if (open) markMenuPhase("rendered");
  }, [open]);
  const presentation = (event: MenuPresentation) => {
    if (event.phase === "appear" && shownToken && event.token > 0) shownToken.current = event.token;
    if (event.phase === "dismiss" && isCurrentShowing(event.token) && !usePageUi.getState().menuOpen) scroll.current?.scrollTo({ y: 0, animated: false });
    onPresentation(event);
  };
  return (
    <Host testID="systemPageMenuSheet" style={styles.anchor} pointerEvents="none">
      <BottomSheet isPresented={open} keepsContentMounted presentationToken={token} onIsPresentedChange={presentationIgnored} onPresentation={presentation}>
        <SystemPageMenuContent tabId={tabId} scroll={scroll} />
      </BottomSheet>
    </Host>
  );
}

function SystemPageMenuContent({ tabId, scroll }: { tabId: string; scroll: RefObject<ScrollViewInstance | null> }) {
  const siteOpen = useMenuPage() === "siteSettings";
  const [menuHeight, setMenuHeight] = useState(lastMenuHeight);
  const measured = (height: number) => {
    if (height <= 0) return;
    const fitted = Math.ceil(height);
    lastMenuHeight = fitted;
    setMenuHeight((now) => (now === fitted ? now : fitted));
  };
  return (
    <Group modifiers={[siteOpen ? presentationDetents([...menuDetents(menuHeight).filter((detent) => detent !== "large"), "large"], SITE_SHEET) : presentationDetents(menuDetents(menuHeight)), presentationDragIndicator("hidden")]}>
      <PageMenuSheetWords tabId={tabId} scroll={scroll} onContentHeight={measured} />
    </Group>
  );
}

const SiteCardOverMenu = memo(function SiteCardOverMenu() {
  const shown = useMenuPage() === "siteSettings";
  const menuOpen = useMenuOpen();
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    if (!menuOpen || warm) return;
    const later = setTimeout(() => setWarm(true), SITE_CARD_WARM_MS);
    return () => clearTimeout(later);
  }, [menuOpen, warm]);
  const built = warm || shown;
  const ink = usePageMenuInk();
  const dim = (useTheme().dark ? menuInk.dark : menuInk.light).dim;
  const progress = useSharedValue(0);
  const cardHeight = useSharedValue(0);
  const layerHeight = useSharedValue(0);
  const [room, setRoom] = useState<number | null>(null);
  const cardScroll = useRef<ScrollViewInstance | null>(null);
  useEffect(() => {
    if (shown) cardScroll.current?.scrollTo({ y: 0, animated: false });
    progress.value = moveTo(shown ? 1 : 0, SITE_CARD_MOTION);
  }, [shown, progress]);
  const dimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - progress.value) * ((cardHeight.value || layerHeight.value) + pageMenuCards.padding) }] }));
  return (
    <View testID="menuSiteLayer" style={StyleSheet.absoluteFill} onLayout={(event) => {
        layerHeight.value = event.nativeEvent.layout.height;
        setRoom(Math.max(0, event.nativeEvent.layout.height - SITE_CARD_TOP - pageMenuCards.padding));
      }} pointerEvents={shown ? "auto" : "none"} accessibilityElementsHidden={!shown} importantForAccessibility={shown ? "auto" : "no-hide-descendants"}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: dim }, dimStyle]}>
        <Pressable testID="menuSiteDim" accessibilityRole="button" accessibilityLabel="Back" style={styles.fill} onPress={closeMenuSubpage} />
      </Animated.View>
      <Animated.View testID="menuSiteCard" style={[styles.card, { backgroundColor: ink.solid }, cardStyle]} onLayout={(event) => (cardHeight.value = event.nativeEvent.layout.height)}>
        {built ? <MenuSiteHeader preMounted onBack={closeMenuSubpage} /> : null}
        <ScrollView ref={cardScroll} testID="menuSiteScroll" style={room === null ? null : { maxHeight: room - pageMenuCards.padding - pageMenuCards.barHeight }} bounces={false} overScrollMode="never" showsVerticalScrollIndicator={false}>
          {built ? <MenuSiteWords preMounted headed={false} lastBottomRadius={concentricRadius(SITE_CARD_BOTTOM_RADIUS, pageMenuCards.padding)} /> : null}
        </ScrollView>
      </Animated.View>
    </View>
  );
});

const SITE_CARD_MOTION = { spring: spring(0.32, 1) };
const SITE_CARD_WARM_MS = 450;
const SITE_SHEET = { selection: "large" as const, onSelectionChange: (detent: PresentationDetent) => (detent === "large" ? undefined : closeMenuSubpage()) };
const SITE_CARD_TOP = pageMenuCards.padding;
const SITE_CARD_TOP_RADIUS = concentricRadius(menuLayout.sheetRadius, pageMenuCards.padding);
const SITE_CARD_BOTTOM_RADIUS = concentricRadius(Math.max(menuLayout.sheetRadius, screenCornerRadius(tabsLayout.displayCornerRadius)), pageMenuCards.padding);

function PageMenuSheetWords({ tabId, scroll, onContentHeight }: { tabId: string; scroll: RefObject<ScrollViewInstance | null>; onContentHeight: (height: number) => void }) {
  const ink = usePageMenuInk();
  const model = useMenuModel(tabId);
  const ask = useTranslationAsk();
  return (
    <ConfirmationDialog title="Translate with Google?" isPresented={ask !== null} onIsPresentedChange={(presented) => (presented ? undefined : releaseTranslationAsk(ask))} titleVisibility="visible">
      <ConfirmationDialog.Trigger>
        <VStack spacing={0} modifiers={[ignoreSafeArea({ edges: "bottom" })]}>
          <RNHostView>
            <View testID="systemPageMenuFill" style={[styles.fill, { backgroundColor: ink.solid }]} onLayout={contentLaidOut}>
              <PageMenuWords tabId={tabId} model={model} onTranslate={askTranslation} systemSheet scrollRef={scroll} onContentHeight={onContentHeight} />
              <SiteCardOverMenu />
            </View>
          </RNHostView>
        </VStack>
      </ConfirmationDialog.Trigger>
      <ConfirmationDialog.Actions>
        <Button label="Translate" onPress={() => confirmTranslation(ask)} />
      </ConfirmationDialog.Actions>
      <ConfirmationDialog.Message>
        <Text>Google will see this page’s address.</Text>
      </ConfirmationDialog.Message>
    </ConfirmationDialog>
  );
}

const styles = StyleSheet.create({
  anchor: { position: "absolute", width: 0, height: 0 },
  fill: { flex: 1 },
  card: {
    position: "absolute",
    left: pageMenuCards.padding,
    right: pageMenuCards.padding,
    bottom: pageMenuCards.padding,
    borderTopLeftRadius: SITE_CARD_TOP_RADIUS,
    borderTopRightRadius: SITE_CARD_TOP_RADIUS,
    borderBottomLeftRadius: SITE_CARD_BOTTOM_RADIUS,
    borderBottomRightRadius: SITE_CARD_BOTTOM_RADIUS,
    ...smoothCorners,
    overflow: "hidden",
  },
});
