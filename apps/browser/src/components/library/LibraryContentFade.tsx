import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Animated } from "react-native";
import { claimLibraryFilterChange, markLibraryChange, noteLibrarySwitch } from "../../state/telemetry/libraryCounts";
import { reduceMotion } from "../ui";
import { LIBRARY_MOTION } from "./motion";

const FILL = { flex: 1 } as const;

export function LibraryContentFade({ animate, shift = 0, token, children }: { animate: boolean; shift?: number; token?: string; children: ReactNode }) {
  const [started] = useState(markLibraryChange);
  const moves = animate && shift !== 0 && !reduceMotion();
  const [opacity] = useState(() => new Animated.Value(animate ? 0 : 1));
  const [offset] = useState(() => new Animated.Value(moves ? shift : 0));
  const [style] = useState(() => [FILL, { opacity, transform: [{ translateY: offset }] }]);
  useEffect(() => {
    if (!animate) return;
    const frame = requestAnimationFrame(() => noteLibrarySwitch(performance.now() - started.at, started.consent));
    const run = Animated.parallel([
      Animated.timing(opacity, { toValue: 1, ...(moves ? LIBRARY_MOTION.page : LIBRARY_MOTION.content), useNativeDriver: true }),
      Animated.timing(offset, { toValue: 0, ...LIBRARY_MOTION.page, useNativeDriver: true }),
    ]);
    run.start();
    return () => {
      cancelAnimationFrame(frame);
      run.stop();
      opacity.setValue(1);
      offset.setValue(0);
    };
  }, []);
  const shownToken = useRef(token);
  useLayoutEffect(() => {
    if (shownToken.current === token) return;
    shownToken.current = token;
    if (!animate) return;
    const changed = claimLibraryFilterChange();
    const frame = changed === null ? null : requestAnimationFrame(() => noteLibrarySwitch(performance.now() - changed.at, changed.consent));
    opacity.setValue(0);
    const run = Animated.timing(opacity, { toValue: 1, ...LIBRARY_MOTION.content, useNativeDriver: true });
    run.start();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      run.stop();
      opacity.setValue(1);
    };
  }, [token]);
  return <Animated.View style={style}>{children}</Animated.View>;
}

export function LibraryPageIn({ shown, shift, style, children }: { shown: boolean; shift: number; style: object; children: ReactNode }) {
  const [opacity] = useState(() => new Animated.Value(1));
  const [offset] = useState(() => new Animated.Value(0));
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) return void (mounted.current = true);
    if (!shown) return;
    const moves = shift !== 0 && !reduceMotion();
    opacity.setValue(0);
    offset.setValue(moves ? shift : 0);
    const run = Animated.parallel([
      Animated.timing(opacity, { toValue: 1, ...LIBRARY_MOTION.page, useNativeDriver: true }),
      Animated.timing(offset, { toValue: 0, ...LIBRARY_MOTION.page, useNativeDriver: true }),
    ]);
    run.start();
    return () => run.stop();
  }, [shown]);
  return <Animated.View style={[style, { opacity, transform: [{ translateY: offset }] }]}>{children}</Animated.View>;
}
