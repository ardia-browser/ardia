import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { deckCurtainOpacity, type DeckCurtain } from "../../lib/deckGeometry";
import { linearGradientCss } from "../../lib/gradient";
import { DeckLookBackdrop, DeckLookBackdropBase, FadeView, LookBackdrop, tabsMotion } from "../ui";
import { deckLook } from "./deckLook";
import type { Reads } from "./DeckCard";

type Props = { curtain: DeckCurtain; width: number; height: number; expandedIndex: Reads<number>; scaleProgress: Reads<number>; reduceMotion: boolean; darkDepth: boolean; incognito: boolean };

export function DeckStripCurtain({ curtain, width, height, expandedIndex, scaleProgress, reduceMotion, darkDepth, incognito }: Props) {
  const plain = useSharedValue(1);
  useAnimatedReaction(
    () => expandedIndex.value < 0,
    (settled, was) => {
      if (!reduceMotion || settled === was) return;
      plain.value = withTiming(settled ? 1 : 0, { duration: tabsMotion.fade });
    },
    [reduceMotion],
  );
  const shown = useAnimatedStyle(() => ({ opacity: reduceMotion ? plain.value : deckCurtainOpacity(expandedIndex.value, scaleProgress.value) }), [reduceMotion]);
  const ramp = { length: curtain.ramp };
  return (
    <Animated.View testID="deckStripCurtain" pointerEvents="none" style={[styles.place, { left: curtain.left, width: curtain.width, height }, shown]}>
      <FadeView testID="deckStripCurtainFade" leading={curtain.fade === "leading" ? ramp : undefined} trailing={curtain.fade === "trailing" ? ramp : undefined} style={styles.fill}>
        <View style={[styles.look, { left: -curtain.left, width, height }]}>
          <DeckLookBackdropBase />
          <DeckLookBackdrop baseOutside />
          {darkDepth ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { experimental_backgroundImage: linearGradientCss(deckLook.darkDepth, false, 0, 0) }]} /> : null}
          {incognito ? <LookBackdrop incognito /> : null}
        </View>
      </FadeView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  place: { position: "absolute", top: 0, overflow: "hidden" },
  fill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, overflow: "hidden" },
  look: { position: "absolute", top: 0 },
});
