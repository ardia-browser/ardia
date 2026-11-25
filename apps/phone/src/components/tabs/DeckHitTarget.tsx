import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { LayoutChangeEvent, StyleProp, ViewStyle } from "react-native";
import Animated, { runOnJS, useAnimatedStyle } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { deckHitAccepted } from "../../state/browse/store";
import { revealStandbyFromDeck } from "../../state/search/standbyReveal";
import { DECK_PRESS_SLOP, deckPressed, deckPressHolds, dropDeckPress, liftDeckControl, placeDeckControl, presentDeckControl, pressDeckControl, type DeckControl } from "../../state/browse/deckTurn";

type Props = { control: DeckControl; live: boolean; originX?: number; originY: number; style?: StyleProp<ViewStyle>; children: ReactNode };

type Laid = { x: number; y: number; width: number; height: number };

export const DECK_PRESSED_SCALE = 0.94;

const DECK_HIT_MS = 500;

export function DeckHitTarget({ control, live, originX = 0, originY, style, children }: Props) {
  const laid = useRef<Laid | null>(null);
  const place = () => {
    const box = laid.current;
    if (!live) return;
    placeDeckControl(control, box && box.width > 0 && box.height > 0 ? { left: originX + box.x, top: originY + box.y, right: originX + box.x + box.width, bottom: originY + box.y + box.height } : null);
  };
  useEffect(place, [live, control, originX, originY]);
  useLayoutEffect(() => {
    if (!live) return;
    presentDeckControl(control, true);
    return () => {
      presentDeckControl(control, false);
      placeDeckControl(control, null);
    };
  }, [live, control]);
  const laidOut = (event: LayoutChangeEvent) => {
    laid.current = event.nativeEvent.layout;
    place();
  };
  const gesture = useMemo(
    () =>
      Gesture.Tap()
        .withTestId(`deckHit:${control}`)
        .enabled(live)
        .maxDistance(DECK_PRESS_SLOP)
        .maxDuration(DECK_HIT_MS)
        .onTouchesDown((event, manager) => {
          const touch = event.allTouches[0];
          if (!touch || !pressDeckControl(control, touch.absoluteX, touch.absoluteY)) manager.fail();
        })
        .onBegin((event) => {
          if (!deckPressHolds(control)) pressDeckControl(control, event.absoluteX, event.absoluteY);
        })
        .onEnd((event, success) => {
          if (!success) {
            dropDeckPress(control);
            return;
          }
          const hit = liftDeckControl(control, event.absoluteX, event.absoluteY);
          if (hit) revealStandbyFromDeck(hit);
          if (hit) runOnJS(deckHitAccepted)(hit);
        })
        .onFinalize(() => {
          dropDeckPress(control);
        }),
    [control, live],
  );
  const pressed = useAnimatedStyle(() => ({ transform: [{ scale: deckPressed.value === control ? DECK_PRESSED_SCALE : 1 }] }));
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View testID={`deckHit-${control}`} collapsable={false} onLayout={laidOut} style={[style, pressed]}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
