import { memo, useMemo } from "react";
import { View, type Animated } from "react-native";
import { layout, useTheme } from "../ui/theme";
import { useAnimatedStyle } from "./EntryMotion";
import { ghostEntry, type EntrySnapshot } from "./GhostEntry";

export const GhostSlot = memo(function GhostSlot({ snapshot, top, opacity }: { snapshot: EntrySnapshot; top: number; opacity: Animated.Value }) {
  const style = useMemo(() => ({ opacity }), [opacity]);
  const [fade, ref] = useAnimatedStyle(style);
  const theme = useTheme();
  return (
    <View pointerEvents="none" {...fade} ref={ref} style={[{ height: 0, marginBottom: -layout.rowGap }, fade.style as object]}>
      {ghostEntry(snapshot, theme, top)}
    </View>
  );
});

