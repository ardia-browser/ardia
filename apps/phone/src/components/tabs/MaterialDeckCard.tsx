import { memo, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useDerivedValue } from "react-native-reanimated";
import { DECK_HEADER, deckBarBand, deckHeaderIconReveal, deckStatusStrip, titleReveal } from "../../lib/deckGeometry";
import { shownTone } from "../../lib/pageTone";
import { snapshotPageTop } from "../../lib/shownSnapshots";
import { isUnseenReceived } from "../../lib/tabFace";
import { countRender } from "../../state/app/interactionPerf";
import { useHeldPageTone } from "../../state/browse/deckHold";
import { display } from "../../state/search/omnibox";
import { useIncognito } from "../../state/tabs/hooks";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { barHeight, FadeView, Favicon, screenReaderActions, Symbol, TabFace, tabsInk, tabsLayout, usePageUnderBars, useReduceMotion, useTheme } from "../ui";
import { rolesFromScheme } from "../ui/materialRoles";
import { materialShape, materialSize, materialType } from "../ui/materialTokens";
import { nativeMenus } from "../ui/MenuTrigger";
import { DeckCardMenu, deckCardStyles, ReceivedBadge, sameCard, useCardPlacement, type DeckCardProps } from "./DeckCard";
import { MATERIAL_DECK, materialOnScreen, useDeckScheme } from "./MaterialDeckLayout";
import { t } from "../../lib/uiLanguage";


export const MaterialDeckCard = memo(function MaterialDeckCard({ tab, index, geometry: g, motion, onOpen, onClose, onCloseNow }: DeckCardProps) {
  countRender(t(`DeckCard`));
  const theme = useTheme();
  const reduceMotion = useReduceMotion();
  const scheme = useDeckScheme(tab.isPrivate);
  const backdrop = useDeckScheme(useIncognito());
  const roles = useMemo(() => (tab.isPrivate ? { ...theme, ...rolesFromScheme(scheme, true) } : theme), [tab.isPrivate, theme, scheme]);
  const tone = shownTone(useHeldPageTone(tab.id), tab.themeColorHex);
  const { scaleProgress } = motion;
  const { placed, cardStyle, reachStyle } = useCardPlacement(tab.id, g, motion, materialShape.large);
  const shownWidth = useDerivedValue(() => {
    const { pose: p, growing, restLeft } = placed.value;
    const left = growing ? restLeft : p.x - (g.cardWidth * p.scale) / 2;
    return materialOnScreen(g, left, p.visible);
  }, [g]);
  const headerStyle = useAnimatedStyle(() => {
    const { pose: p, top } = placed.value;
    const left = p.x - (g.cardWidth * p.scale) / 2;
    return { zIndex: placed.value.z + 1, opacity: p.header, transform: [{ translateX: left + shownWidth.value - g.cardWidth }, { translateY: top }] };
  });
  const rowStyle = useAnimatedStyle(() => {
    const room = shownWidth.value - materialSize.touchTarget;
    return { opacity: deckHeaderIconReveal(room, tabsLayout.faviconSize), transform: [{ translateX: g.cardWidth - shownWidth.value + MATERIAL_DECK.headerInset }] };
  });
  const titleStyle = useAnimatedStyle(() => ({ opacity: titleReveal(shownWidth.value - materialSize.touchTarget) }));
  const closeStyle = useAnimatedStyle(() => ({ opacity: Math.min(Math.max((shownWidth.value - MATERIAL_DECK.closeShownFrom) / DECK_HEADER.iconFade + 1, 0), 1) }));
  const underBars = usePageUnderBars();
  const pageTop = (tab.snapshotFileName ? snapshotPageTop(tab.snapshotFileName) : null) ?? (underBars ? 0 : g.safeTop);
  const faceStyle = useAnimatedStyle(() => ({ transform: [{ translateY: placed.value.expanded ? deckStatusStrip(g, scaleProgress.value, pageTop) : 0 }] }), [g, pageTop]);
  const bar = deckBarBand(g, barHeight(g.safeBottom, "material"), 1);
  const bandStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: placed.value.expanded && !underBars ? deckBarBand(g, 0, scaleProgress.value).grown : 0 }] }), [g, underBars]);
  const host = display(tab.url).host;
  const title = tab.title || host || t(`New Tab`);
  const fill = tone.top ?? scheme.surfaceContainerLow;
  const cardContents = (
    <>
      <Animated.View testID="deckCardFace" style={[StyleSheet.absoluteFill, faceStyle]}>
        <TabFace tab={tab} title={title} host={host} tone={tone.top} roles={roles} paintedAs={`deck:${tab.id}`} />
      </Animated.View>
      <Animated.View testID="deckCardBarBand" pointerEvents="none" style={[deckCardStyles.band, { height: bar.height, backgroundColor: tone.bottom ?? theme.surface }, bandStyle]} />
      {isUnseenReceived(tab) ? <ReceivedBadge /> : null}
    </>
  );
  const shadowStyle = useAnimatedStyle(() => ({ elevation: placed.value.growing ? 0 : MATERIAL_DECK.cardElevation }));
  return (
    <>
      <Animated.View
        testID="deckCard"
        needsOffscreenAlphaCompositing={reduceMotion}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.card, { width: g.cardWidth, height: g.cardHeight, backgroundColor: fill }, cardStyle, shadowStyle]}
      >
        {nativeMenus() ? (
          <DeckCardMenu tab={tab} index={index} onClose={onClose} fill={fill}>
            {cardContents}
          </DeckCardMenu>
        ) : (
          cardContents
        )}
      </Animated.View>
      <Animated.View
        accessible
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityValue={{ text: tab.isPrivate ? `Incognito, ${host}` : host }}
        accessibilityHint={t(`Opens the tab.`)}
        {...screenReaderActions([
          { name: "activate", run: () => onOpen(index) },
          { name: "close", label: t(`Close Tab`), run: () => onCloseNow(index) },
        ])}
        pointerEvents="none"
        style={[deckCardStyles.reach, { width: g.cardWidth, height: g.cardHeight }, reachStyle]}
      />
      <Animated.View style={[styles.header, { width: g.cardWidth }, headerStyle]} pointerEvents="box-none">
        <FadeView testID="deckHeaderFade" trailing={{ length: DECK_HEADER.trailingFade }} pointerEvents="none" style={[styles.titleArea, { right: materialSize.touchTarget }]}>
          <Animated.View style={[styles.headerRow, rowStyle]}>
            <MaterialCardIcon tab={tab} />
            <Animated.Text testID="deckHeaderTitle" maxFontSizeMultiplier={DECK_HEADER.maxFontScale} style={[materialType.labelLarge, styles.title, { color: backdrop.onSurface }, titleStyle]} numberOfLines={1}>
              {title}
            </Animated.Text>
          </Animated.View>
        </FadeView>
        <Animated.View style={[styles.closeSlot, closeStyle]}>
          <MaterialCardClose color={backdrop.onSurfaceVariant} />
        </Animated.View>
      </Animated.View>
    </>
  );
}, sameCard);

function MaterialCardClose({ color }: { color: string }) {
  return (
    <View testID="materialCardClose" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.close}>
      <Symbol name="xmark" size={MATERIAL_DECK.closeIcon} color={color} />
    </View>
  );
}

function MaterialCardIcon({ tab }: { tab: BrowserTab }) {
  const scheme = useDeckScheme(tab.isPrivate);
  const backdrop = useDeckScheme(useIncognito());
  if (!tab.isPrivate) return <Favicon iconUrl={tab.faviconUrl} pageUrl={tab.url} size={tabsLayout.faviconSize} />;
  return (
    <View testID="materialCardIncognitoIcon" style={[styles.privateIcon, { backgroundColor: scheme.surfaceContainerHighest }]}>
      <Symbol name="eyes" size={tabsLayout.faviconSize - 4} color={scheme.onSurface} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { position: "absolute", left: 0, top: 0, overflow: "hidden", elevation: MATERIAL_DECK.cardElevation, shadowColor: tabsInk.cardShadow },
  header: { position: "absolute", left: 0, top: 0, height: tabsLayout.headerHeight },
  titleArea: { position: "absolute", left: 0, top: 0, bottom: 0, overflow: "hidden" },
  headerRow: { position: "absolute", left: 0, top: 0, width: 2000, flexDirection: "row", alignItems: "center", gap: tabsLayout.headerSpacing + 2, height: tabsLayout.headerHeight },
  title: { includeFontPadding: false },
  closeSlot: { position: "absolute", right: 0, top: (tabsLayout.headerHeight - materialSize.touchTarget) / 2, width: materialSize.touchTarget, height: materialSize.touchTarget },
  close: { width: materialSize.touchTarget, height: materialSize.touchTarget, alignItems: "center", justifyContent: "center", borderRadius: materialShape.full },
  privateIcon: { width: tabsLayout.faviconSize, height: tabsLayout.faviconSize, borderRadius: materialShape.full, alignItems: "center", justifyContent: "center" },
});
