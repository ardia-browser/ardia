import { type ReactNode, useMemo } from "react";
import { Animated } from "react-native";
import { bouncePressMotion, usePressMotion, usePressScaleMotion } from "./motion";

type SquishKind = "row" | "tile";

const SQUISH_SCALE: Record<SquishKind, number> = { row: bouncePressMotion.rowPressScale, tile: bouncePressMotion.tilePressScale };

export function useSquish(kind: SquishKind | null | undefined) {
  const on = usePressMotion() === "bounce" && !!kind;
  return usePressScaleMotion(on, kind ? SQUISH_SCALE[kind] : undefined);
}

export function Squish({ scale, children }: { scale: Animated.Value | null; children: ReactNode }) {
  const style = useMemo(() => (scale ? { transform: [{ scale }] } : null), [scale]);
  return style ? <Animated.View style={style}>{children}</Animated.View> : children;
}
