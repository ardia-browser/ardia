import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { deckClipShift, deckStripClips, type DeckGeometry } from "../../lib/deckGeometry";
import type { DeckMotion } from "./DeckCard";

type Props = { geometry: DeckGeometry; motion: DeckMotion; children: ReactNode };

export function DeckStripClip(props: Props) {
  return deckStripClips(props.geometry) ? <StripClip {...props} /> : props.children;
}

function StripClip({ geometry: g, motion, children }: Props) {
  const shift = deckClipShift(g);
  const { expandedIndex } = motion;
  const clipWindow = useAnimatedStyle(() => ({ transform: [{ translateX: expandedIndex.value >= 0 ? 0 : shift }] }), [shift]);
  const cards = useAnimatedStyle(() => ({ transform: [{ translateX: expandedIndex.value >= 0 ? 0 : -shift }] }), [shift]);
  return (
    <Animated.View testID="deckStripClip" pointerEvents="box-none" collapsable={false} style={[styles.box, { width: g.width, height: g.height }, clipWindow]}>
      <Animated.View pointerEvents="box-none" collapsable={false} style={[styles.box, { width: g.width, height: g.height }, cards]}>
        {children}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: { position: "absolute", left: 0, top: 0, overflow: "hidden" },
});
