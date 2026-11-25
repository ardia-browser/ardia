import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { runOnJS, useAnimatedReaction } from "react-native-reanimated";

export const FABRIC_CATCH_UP_MS = 120;

export const fabricLagsAnimations = Platform.OS === "android" || Platform.OS === "ios";

type Props = { motion: () => number; testID?: string };

export function FabricCatchUp(props: Props) {
  return fabricLagsAnimations ? <CatchUp {...props} /> : null;
}

function CatchUp({ motion, testID = "fabricCatchUp" }: Props) {
  const [commits, commit] = useState(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moved = useCallback(() => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      commit((count) => count + 1);
    }, FABRIC_CATCH_UP_MS);
  }, []);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );
  useAnimatedReaction(motion, (now, was) => {
    if (was !== null && now !== was) runOnJS(moved)();
  });
  return <View key={commits} testID={testID} pointerEvents="none" style={styles.leaf} />;
}

const styles = StyleSheet.create({ leaf: { position: "absolute", width: 0, height: 0 } });
