import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { runOnJS, useAnimatedReaction, useSharedValue } from "react-native-reanimated";

export const FABRIC_CATCH_UP_MS = 120;

export const FABRIC_CATCH_UP_PING_MS = 60;

export const fabricLagsAnimations = Platform.OS === "android" || Platform.OS === "ios";

type Props = { motion: () => number; testID?: string; pingMs?: number };

export function FabricCatchUp(props: Props) {
  return fabricLagsAnimations ? <CatchUp {...props} /> : null;
}

function CatchUp({ motion, testID = "fabricCatchUp", pingMs = 0 }: Props) {
  const [commits, commit] = useState(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingedAt = useSharedValue(0);
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
    if (was === null || now === was) return;
    const at = Date.now();
    if (at - pingedAt.value < pingMs) return;
    pingedAt.value = at;
    runOnJS(moved)();
  });
  return <View key={commits} testID={testID} pointerEvents="none" style={styles.leaf} />;
}

const styles = StyleSheet.create({ leaf: { position: "absolute", width: 0, height: 0 } });
