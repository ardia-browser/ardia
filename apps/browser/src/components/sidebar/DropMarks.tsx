import { StyleSheet, View } from "react-native";
import { continuousCorners, radius } from "../ui";
import type { SplitDropSide } from "../../state/drag/drops";
import { SPLIT_DROP } from "./tokens";

export function SplitDropHalf({ side, fill }: { side: SplitDropSide | null; fill: string }) {
  if (!side) return null;
  return (
    <View pointerEvents="none" style={HALVES}>
      <View style={[HALF, continuousCorners(radius.chrome), { backgroundColor: side === "left" ? fill : undefined }]} />
      <View style={[HALF, continuousCorners(radius.chrome), { backgroundColor: side === "right" ? fill : undefined }]} />
    </View>
  );
}

const HALVES = { ...StyleSheet.absoluteFillObject, flexDirection: "row", gap: SPLIT_DROP.gap } as const;
const HALF = { flex: 1 } as const;
