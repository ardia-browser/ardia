import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, type LayoutChangeEvent } from "react-native";
import { reduceMotion, useCrossfade } from "../ui";
import { curve } from "../ui/motion";

const Leaving = createContext(false);

export const useLeaving = () => useContext(Leaving);

export function Morph({ id, children }: { id: string; children: ReactNode }) {
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
    run.current = Animated.timing(height, { toValue: next, duration: MORPH_MS, easing: curve.move, useNativeDriver: false });
    run.current.start();
  };
  return (
    <Animated.View style={sized ? { height, overflow: "hidden" } : undefined}>
      <Animated.View onLayout={onLayout} style={[sized ? MORPH_CONTENT : undefined, { opacity: fade }]}>
        {children}
      </Animated.View>
      {leaving ? (
        <Animated.View pointerEvents="none" importantForAccessibility="no-hide-descendants" style={[LEAVING, { opacity: fade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }]}>
          <Leaving.Provider value>{leaving}</Leaving.Provider>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const MORPH_MS = 220;
const MORPH_CONTENT = { position: "absolute", left: 0, right: 0, top: 0 } as const;
const LEAVING = { position: "absolute", left: 0, right: 0, top: 0 } as const;
