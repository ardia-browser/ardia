import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, View, type LayoutChangeEvent } from "react-native";
import { reduceMotion, useCrossfade } from "../ui";
import { curve } from "../ui/motion";
import { SHEET_INSET, SHEET_LIST_INSET, VAULT_SIGN_IN } from "./tokens";

const Leaving = createContext(false);

export const useLeaving = () => useContext(Leaving);

export function Morph({ id, slide = 0, children }: { id: string; slide?: -1 | 0 | 1; children: ReactNode }) {
  const height = useRef(new Animated.Value(0)).current;
  const { fade, leaving } = useCrossfade(id, children);
  const [sized, setSized] = useState(false);
  const target = useRef<number | null>(null);
  const run = useRef<Animated.CompositeAnimation | null>(null);
  useEffect(() => () => run.current?.stop(), []);
  const onLayout = (e: LayoutChangeEvent) => {
    const next = Math.ceil(e.nativeEvent.layout.height);
    if (target.current === next) return;
    const first = target.current === null;
    target.current = next;
    run.current?.stop();
    if (first || reduceMotion() === true) {
      height.setValue(next);
      if (!sized) setSized(true);
      return;
    }
    run.current = Animated.timing(height, { toValue: next, duration: VAULT_SIGN_IN.morphMs, easing: curve.move, useNativeDriver: false });
    run.current.start();
  };
  const shift = slide && reduceMotion() !== true ? slide * VAULT_SIGN_IN.stepShift : 0;
  const entering = shift ? { opacity: fade, transform: [{ translateX: fade.interpolate({ inputRange: [0, 1], outputRange: [shift, 0] }) }] } : { opacity: fade };
  const exiting = fade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const exitingStyle = shift ? { opacity: exiting, transform: [{ translateX: fade.interpolate({ inputRange: [0, 1], outputRange: [0, -shift] }) }] } : { opacity: exiting };
  return (
    <Animated.View style={[BLEED, sized ? { height, overflow: "hidden" } : undefined]}>
      <Animated.View onLayout={onLayout} style={[sized ? MORPH_CONTENT : undefined, entering]}>
        <View style={INSET}>{children}</View>
      </Animated.View>
      {leaving ? (
        <Animated.View pointerEvents="none" importantForAccessibility="no-hide-descendants" style={[LEAVING, exitingStyle]}>
          <View style={INSET}>
            <Leaving.Provider value>{leaving}</Leaving.Provider>
          </View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const BLEED = { marginHorizontal: SHEET_LIST_INSET - SHEET_INSET } as const;
const INSET = { marginHorizontal: SHEET_INSET - SHEET_LIST_INSET } as const;
const MORPH_CONTENT = { position: "absolute", left: 0, right: 0, top: 0 } as const;
const LEAVING = { position: "absolute", left: 0, right: 0, top: 0 } as const;
