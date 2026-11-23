import { LayoutAnimation, type LayoutAnimationConfig } from "react-native";

export const layoutOnCompositor = true;

export function animateNextLayout(ms: number, controlPoints: readonly [number, number, number, number]) {
  const update = { type: LayoutAnimation.Types.easeOut, controlPoints: [...controlPoints] };
  LayoutAnimation.configureNext({ duration: ms, update } as LayoutAnimationConfig);
}
