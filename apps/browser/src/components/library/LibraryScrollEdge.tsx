import { createContext, memo, useContext, useEffect, useState } from "react";
import { Animated } from "react-native";
import { ProgressiveBlur } from "../ui/ProgressiveBlur";
import { LIBRARY } from "./tokens";

const E = LIBRARY.scrollEdge;

export type LibraryScrollFrame = { inset: number; onScrolled: (scrolled: boolean) => void };

const RESTING: LibraryScrollFrame = { inset: 0, onScrolled: () => {} };

export const LibraryScrollContext = createContext<LibraryScrollFrame>(RESTING);

export const useLibraryScrollFrame = () => useContext(LibraryScrollContext);

export const LibraryScrollEdge = memo(function LibraryScrollEdge({ inset, scrolled }: { inset: number; scrolled: boolean }) {
  const [opacity] = useState(() => new Animated.Value(scrolled ? 1 : 0));
  useEffect(() => {
    const run = Animated.timing(opacity, { toValue: scrolled ? 1 : 0, duration: E.fadeMs, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [opacity, scrolled]);
  const height = inset + E.below;
  if (inset <= 0) return null;
  return (
    <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, height, opacity }}>
      <ProgressiveBlur style={FILL} radius={E.radius} solidShare={E.solidShare} />
    </Animated.View>
  );
});

const FILL = { flex: 1 } as const;
