import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { deckCurtainSlices, type DeckGeometry } from "../../lib/deckGeometry";
import { linearGradientCss } from "../../lib/gradient";
import { DeckLookBackdrop, DeckLookBackdropBase, LookBackdrop } from "../ui";
import { deckLook } from "./deckLook";
import type { Reads } from "./DeckCard";

type Props = { geometry: DeckGeometry; expandedIndex: Reads<number>; darkDepth: boolean; incognito: boolean };

const CURTAIN_BACK_MS = 150;

export function DeckStripCurtain({ geometry: g, expandedIndex, darkDepth, incognito }: Props) {
  const slices = deckCurtainSlices(g);
  const shown = useSharedValue(1);
  useAnimatedReaction(
    () => expandedIndex.value < 0,
    (settled, was) => {
      if (settled === was) return;
      shown.value = settled ? withTiming(1, { duration: CURTAIN_BACK_MS }) : 0;
    },
  );
  const curtain = useAnimatedStyle(() => ({ opacity: shown.value }));
  if (!slices.length) return null;
  return (
    <Animated.View testID="deckStripCurtain" pointerEvents="none" style={[StyleSheet.absoluteFill, curtain]}>
      {slices.map((slice) => (
        <View key={slice.left} testID="deckStripCurtainSlice" style={[styles.slice, { left: slice.left, width: slice.width, height: g.height, opacity: slice.opacity }]}>
          <View style={[styles.look, { left: -slice.left, width: g.width, height: g.height }]}>
            <DeckLookBackdropBase />
            <DeckLookBackdrop baseOutside />
            {darkDepth ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { experimental_backgroundImage: linearGradientCss(deckLook.darkDepth, false, 0, 0) }]} /> : null}
            {incognito ? <LookBackdrop incognito /> : null}
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  slice: { position: "absolute", top: 0, overflow: "hidden" },
  look: { position: "absolute", top: 0 },
});
